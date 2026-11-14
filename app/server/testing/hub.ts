// A fake Hugging Face Hub on loopback, for the tests of the Hub client, of its routes and of the downloads: the API
// (`/api/models?…`, `/api/models/<id>/revision/<rev>?blobs=true`, `/api/whoami-v2`), the downloads
// (`/<repo>/resolve/<rev>/<path>`, redirected to a second "CDN" server that honours `Range`), failures and silences to
// order, and the requests it saw with their headers. Plain Node: it drives the client from outside. Runnable on its own
// for a look at the app against it: `node app/server/testing/hub.ts --port <n> --dir <folder>` (the repositories are
// the folders `<dir>/<org>/<name>`, their files every file under them).
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { join, relative } from 'node:path';
import { parseArgs } from 'node:util';
import { Effect, type Scope } from 'effect';
import { until } from './llama.ts';

/** A file of a repository: its bytes, and (a GGUF by default) its LFS pointer, whose sha256 can be set wrong. */
export type HubFile =
  | string
  | Uint8Array
  | { readonly body: string | Uint8Array; readonly lfs?: boolean; readonly sha256?: string };

/** A repository of the fake Hub. */
export interface HubRepo {
  readonly id: string;
  /** Its commit (40 hex): the sha1 of its id by default. */
  readonly sha?: string;
  /** As the Hub writes it: `false`, `'manual'` or `'auto'`. */
  readonly gated?: false | 'manual' | 'auto';
  readonly downloads?: number;
  readonly likes?: number;
  readonly lastModified?: string;
  readonly files: Readonly<Record<string, HubFile>>;
}

/** The routes a failure can be ordered on. */
export type HubRoute = 'search' | 'repo' | 'whoami' | 'resolve' | 'cdn';

/**
 * What a request gets instead of its answer: a status (headers and body as given); `silence`, no answer at all (until
 * the client leaves); `cut`, the headers and the first `cut` bytes of the body, then the connection broken; `stall`,
 * the headers and the first `stall` bytes, then nothing more.
 */
export type HubFault =
  | { readonly status: number; readonly headers?: Readonly<Record<string, string>>; readonly body?: string }
  | { readonly silence: true }
  | { readonly cut: number }
  | { readonly stall: number };

/** A request the fake saw. */
export interface HubRequest {
  readonly server: 'hub' | 'cdn';
  readonly route: HubRoute | null;
  readonly method: string;
  readonly url: string;
  readonly headers: IncomingHttpHeaders;
}

export interface FakeHub {
  /** The Hub's base URL (`HF_ENDPOINT`). */
  readonly url: string;
  /** The CDN's base URL (where `resolve` redirects). */
  readonly cdnUrl: string;
  /** Adds or replaces a repository. */
  readonly add: (repo: HubRepo) => void;
  /** The commit of a repository. */
  readonly shaOf: (id: string) => string;
  /** The next `times` (1) requests of `route` get `fault`. */
  readonly fail: (route: HubRoute, fault: HubFault, times?: number) => void;
  /** The requests seen so far, in order. */
  readonly requests: () => ReadonlyArray<HubRequest>;
  /** How many answers their client left before they ended. */
  readonly aborted: () => number;
  /** Waits (real time) until `n` requests of `route` (of any route, without one) have arrived. */
  readonly requested: (n: number, route?: HubRoute) => Effect.Effect<void>;
  /** Waits (real time) until `n` answers have been left by their client before they ended. */
  readonly abandoned: (n: number) => Effect.Effect<void>;
}

export interface HubOptions {
  readonly repos?: ReadonlyArray<HubRepo>;
  /** The tokens `whoami` accepts, with their account name. */
  readonly tokens?: Readonly<Record<string, string>>;
  readonly host?: string;
  /** The Hub's port (0, a free one, by default); the CDN takes a free one. */
  readonly port?: number;
}

interface Stored {
  readonly body: Buffer;
  readonly lfs: { readonly sha256: string; readonly size: number } | null;
}

interface Entry {
  readonly repo: HubRepo;
  readonly sha: string;
  readonly files: Map<string, Stored>;
}

const sha1 = (text: string) => createHash('sha1').update(text).digest('hex');
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

const store = (path: string, file: HubFile): Stored => {
  const spec = typeof file === 'string' || file instanceof Uint8Array ? { body: file } : file;
  const body = Buffer.from(spec.body);
  const lfs = spec.lfs ?? /\.gguf$/i.test(path);
  return { body, lfs: lfs ? { sha256: spec.sha256 ?? sha256(body), size: body.length } : null };
};

const listen = (server: Server, port: number, host: string) =>
  new Promise<number>((done, fail) => {
    server.once('error', fail);
    server.listen(port, host, () => done((server.address() as AddressInfo).port));
  });

const close = (server: Server) =>
  new Promise<void>((done) => {
    server.closeAllConnections();
    server.close(() => done());
  });

const json = (res: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}) => {
  res.writeHead(status, { 'content-type': 'application/json', ...headers }).end(JSON.stringify(value));
};

/** The ports a fake never takes: the app's (7860, 7861) and llama-server's (8080). */
const FORBIDDEN = new Set([7860, 7861, 8080]);

/** Starts the fake Hub and its CDN; `close` stops both and cuts their connections. */
export async function startHub(options: HubOptions = {}): Promise<FakeHub & { readonly close: () => Promise<void> }> {
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? 0;
  if (FORBIDDEN.has(port)) throw new Error(`the fake Hub never listens on port ${port}`);
  const repos = new Map<string, Entry>();
  const tokens = new Map(Object.entries(options.tokens ?? {}));
  const faults = new Map<HubRoute, Array<HubFault>>();
  const seen: Array<HubRequest> = [];
  let aborted = 0;

  const add = (repo: HubRepo) => {
    const files = new Map(Object.entries(repo.files).map(([path, file]) => [path, store(path, file)] as const));
    repos.set(repo.id, { repo, sha: repo.sha ?? sha1(repo.id), files });
  };
  for (const repo of options.repos ?? []) add(repo);

  const track = (server: 'hub' | 'cdn', route: HubRoute | null, req: IncomingMessage, res: ServerResponse) => {
    seen.push({ server, route, method: req.method ?? 'GET', url: req.url ?? '/', headers: req.headers });
    res.on('close', () => {
      if (!res.writableFinished) aborted++;
    });
    return route === null ? undefined : faults.get(route)?.shift();
  };

  /**
   * Answers with `fault` when there is one (a status as ordered, silence, or `body` cut or stalled after its first
   * bytes, with `status` and `headers`), else with `status`, `headers` and `body`.
   */
  const answer = (
    res: ServerResponse,
    fault: HubFault | undefined,
    answer: { status: number; headers: Record<string, string>; body: Buffer | string | undefined },
  ) => {
    if (fault === undefined) {
      res.writeHead(answer.status, answer.headers).end(answer.body);
      return;
    }
    if ('status' in fault) {
      res.writeHead(fault.status, { ...fault.headers }).end(fault.body ?? '');
      return;
    }
    if ('silence' in fault) return;
    const after = 'cut' in fault ? fault.cut : fault.stall;
    res.writeHead(answer.status, answer.headers);
    res.write(Buffer.from(answer.body ?? '').subarray(0, after));
    // Unref'd: a cut still pending when the Hub closes does not hold the process.
    if ('cut' in fault) setTimeout(() => res.destroy(), 20).unref();
  };

  const cdn = createServer((req, res) => {
    const fault = track('cdn', 'cdn', req, res);
    const url = new URL(req.url ?? '/', 'http://cdn');
    const [org, name, sha, ...rest] = url.pathname
      .split('/')
      .filter((part) => part !== '')
      .map(decodeURIComponent);
    const entry = repos.get(`${org}/${name}`);
    const file = entry !== undefined && entry.sha === sha ? entry.files.get(rest.join('/')) : undefined;
    const head = req.method === 'HEAD';
    if (file === undefined) {
      answer(res, fault, { status: 404, headers: {}, body: undefined });
      return;
    }
    const total = file.body.length;
    const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '');
    if (range === null) {
      const headers = { 'content-type': 'application/octet-stream', 'content-length': String(total) };
      answer(res, fault, {
        status: 200,
        headers: { ...headers, 'accept-ranges': 'bytes' },
        body: head ? undefined : file.body,
      });
      return;
    }
    const start = Number(range[1]);
    const end = range[2] === '' ? total - 1 : Math.min(Number(range[2]), total - 1);
    if (start >= total || end < start) {
      answer(res, fault, { status: 416, headers: { 'content-range': `bytes */${total}` }, body: undefined });
      return;
    }
    const part = file.body.subarray(start, end + 1);
    const headers = {
      'content-type': 'application/octet-stream',
      'content-length': String(part.length),
      'content-range': `bytes ${start}-${end}/${total}`,
      'accept-ranges': 'bytes',
    };
    answer(res, fault, { status: 206, headers, body: head ? undefined : part });
  });
  const cdnPort = await listen(cdn, 0, host);
  const cdnUrl = `http://${host}:${cdnPort}`;

  const notFound = (code: string, message: string) => ({
    status: 404,
    headers: { 'content-type': 'application/json', 'x-error-code': code, 'x-error-message': message },
    body: JSON.stringify({ error: message }),
  });
  const ok = (value: unknown) => ({
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(value),
  });

  const hub = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://hub');
    const parts = url.pathname
      .split('/')
      .filter((part) => part !== '')
      .map(decodeURIComponent);
    if (url.pathname === '/api/models') {
      const fault = track('hub', 'search', req, res);
      const search = (url.searchParams.get('search') ?? '').toLowerCase();
      const limit = Number(url.searchParams.get('limit') ?? '1000');
      const gguf = url.searchParams.get('filter') === 'gguf';
      const rows = [...repos.values()]
        .filter(({ repo }) => repo.id.toLowerCase().includes(search))
        .filter(({ files }) => !gguf || [...files.keys()].some((path) => /\.gguf$/i.test(path)))
        .sort((a, b) => (b.repo.downloads ?? 0) - (a.repo.downloads ?? 0))
        .slice(0, limit)
        .map(({ repo }) => ({
          _id: sha1(`_id ${repo.id}`).slice(0, 24),
          id: repo.id,
          downloads: repo.downloads ?? 0,
          likes: repo.likes ?? 0,
          gated: repo.gated ?? false,
          lastModified: repo.lastModified ?? '2026-01-01T00:00:00.000Z',
        }));
      answer(res, fault, ok(rows));
      return;
    }
    if (url.pathname === '/api/whoami-v2') {
      const fault = track('hub', 'whoami', req, res);
      const token = req.headers.authorization?.replace(/^Bearer /, '');
      const name = token === undefined ? undefined : tokens.get(token);
      answer(
        res,
        fault,
        name === undefined
          ? {
              status: 401,
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ error: 'Invalid credentials in Authorization header' }),
            }
          : ok({ type: 'user', name }),
      );
      return;
    }
    // /api/models/<org>/<name>/revision/<rev>
    if (parts[0] === 'api' && parts[1] === 'models' && parts[4] === 'revision' && parts.length === 6) {
      const fault = track('hub', 'repo', req, res);
      const entry = repos.get(`${parts[2]}/${parts[3]}`);
      const rev = parts[5];
      if (entry === undefined) {
        answer(res, fault, notFound('RepoNotFound', 'Repository not found'));
        return;
      }
      if (rev !== 'main' && rev !== entry.sha) {
        answer(res, fault, notFound('RevisionNotFound', `Invalid rev id: ${rev}`));
        return;
      }
      const siblings = [...entry.files].map(([path, file]) =>
        file.lfs === null
          ? { rfilename: path, size: file.body.length }
          : { rfilename: path, size: file.body.length, blobId: sha1(path), lfs: { ...file.lfs, pointerSize: 134 } },
      );
      answer(res, fault, ok({ id: entry.repo.id, sha: entry.sha, gated: entry.repo.gated ?? false, siblings }));
      return;
    }
    // /<org>/<name>/resolve/<rev>/<path…>
    if (parts[2] === 'resolve' && parts.length >= 5) {
      const fault = track('hub', 'resolve', req, res);
      const entry = repos.get(`${parts[0]}/${parts[1]}`);
      const rev = parts[3];
      const path = parts.slice(4).join('/');
      if (entry === undefined) {
        answer(res, fault, notFound('RepoNotFound', 'Repository not found'));
        return;
      }
      if (entry.repo.gated && req.headers.authorization === undefined) {
        const message = 'Access to this model is restricted';
        answer(res, fault, {
          status: 403,
          headers: { 'x-error-code': 'GatedRepo', 'x-error-message': message },
          body: message,
        });
        return;
      }
      if (rev !== 'main' && rev !== entry.sha) {
        answer(res, fault, notFound('RevisionNotFound', `Invalid rev id: ${rev}`));
        return;
      }
      if (!entry.files.has(path)) {
        answer(res, fault, notFound('EntryNotFound', `${path} does not exist`));
        return;
      }
      const encoded = path.split('/').map(encodeURIComponent).join('/');
      const location = `${cdnUrl}/${entry.repo.id}/${entry.sha}/${encoded}?sig=1`;
      answer(res, fault, { status: 302, headers: { location }, body: undefined });
      return;
    }
    track('hub', null, req, res);
    json(res, 404, { error: 'Not found' });
  });
  const hubPort = await listen(hub, port, host).catch(async (error: unknown) => {
    await close(cdn);
    throw error;
  });

  return {
    url: `http://${host}:${hubPort}`,
    cdnUrl,
    add,
    shaOf: (id) => repos.get(id)?.sha ?? sha1(id),
    fail: (route, fault, times = 1) => {
      const queue = faults.get(route) ?? [];
      for (let i = 0; i < times; i++) queue.push(fault);
      faults.set(route, queue);
    },
    requests: () => seen,
    aborted: () => aborted,
    requested: (n, route) =>
      until(() => seen.filter((request) => route === undefined || request.route === route).length >= n),
    abandoned: (n) => until(() => aborted >= n),
    close: async () => {
      await Promise.all([close(hub), close(cdn)]);
    },
  };
}

/** The fake Hub and its CDN for the life of the scope. */
export const fakeHub = (options: HubOptions = {}): Effect.Effect<FakeHub, never, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.promise(() => startHub(options)),
    (hub) => Effect.promise(hub.close),
  );

/** The repositories of a folder: each `<dir>/<org>/<name>` is one, its files every file under it. */
async function reposOf(dir: string): Promise<Array<HubRepo>> {
  const repos: Array<HubRepo> = [];
  for (const org of await readdir(dir, { withFileTypes: true })) {
    if (!org.isDirectory()) continue;
    for (const name of await readdir(join(dir, org.name), { withFileTypes: true })) {
      if (!name.isDirectory()) continue;
      const root = join(dir, org.name, name.name);
      const files: Record<string, Uint8Array> = {};
      for (const file of await readdir(root, { withFileTypes: true, recursive: true })) {
        if (!file.isFile()) continue;
        const path = join(file.parentPath, file.name);
        files[relative(root, path)] = await readFile(path);
      }
      repos.push({ id: `${org.name}/${name.name}`, files });
    }
  }
  return repos;
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { port: { type: 'string' }, dir: { type: 'string' } } });
  if (values.port === undefined || values.dir === undefined) {
    console.error('usage: node app/server/testing/hub.ts --port <n> --dir <folder>');
    process.exit(2);
  }
  const hub = await startHub({ port: Number(values.port), repos: await reposOf(values.dir) });
  console.log(`fake Hub on ${hub.url} (CDN ${hub.cdnUrl}): HF_ENDPOINT=${hub.url}`);
  const stop = () => {
    void hub.close().then(() => process.exit(0));
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}
