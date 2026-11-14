// What the tests of the supervisor and of the requests to a llama-server share: the fake llama-server, free ports, HTTP
// stubs on loopback, a fake started outside llama-webui, and the proxy of the environment. Plain Node: these drive the
// platform from outside.
import { type ChildProcess, spawn } from 'node:child_process';
import { createServer, type IncomingMessage, type Server, type ServerResponse, setGlobalProxyFromEnv } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { Effect, type Scope } from 'effect';
import { freePort as freePortAsync } from './launch.ts';

/** `testdata/fake/fake-llama-server`: imitates llama-server (see its source for the `FAKE_*` variables). */
export const FAKE = resolve(import.meta.dirname, '../../../testdata/fake/fake-llama-server');

/** A port nothing listens on, on 127.0.0.1, at the time of the call. */
export const freePort: Effect.Effect<number> = Effect.promise(freePortAsync);

/** Whether a process with this pid exists (signal 0). */
export const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** A stub server: its base URL, its port, and how many requests and connection closes it has seen so far. */
export interface Stub {
  readonly url: string;
  readonly port: number;
  readonly requests: () => number;
  readonly closes: () => number;
}

/**
 * An HTTP server on 127.0.0.1 and a free port, answering with `handler`, for the life of the scope: every connection
 * is cut when it closes.
 */
export const httpStub = (
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Effect.Effect<Stub, never, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.promise(async () => {
      let requests = 0;
      let closes = 0;
      const server: Server = createServer((req, res) => {
        requests++;
        handler(req, res);
      });
      server.on('connection', (socket) => socket.once('close', () => closes++));
      await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
      const { port } = server.address() as AddressInfo;
      return {
        server,
        stub: { url: `http://127.0.0.1:${port}`, port, requests: () => requests, closes: () => closes },
      };
    }),
    ({ server }) =>
      Effect.promise(() => {
        server.closeAllConnections();
        return new Promise<void>((done) => server.close(() => done()));
      }),
  ).pipe(Effect.map(({ stub }) => stub));

/** A llama-server whose streamed chat replies the test writes, chunk by chunk. */
export interface ChatStub extends Stub {
  /** The bodies of the chat requests received so far, parsed. */
  readonly bodies: () => ReadonlyArray<unknown>;
  /** Waits until `n` chat requests have arrived (their headers answered). */
  readonly requested: (n: number) => Effect.Effect<void>;
  /** Writes one chunk event, `{"choices":[{"index":0,"delta":…}],…extra}`, to the latest reply. */
  readonly chunk: (
    delta: Readonly<Record<string, unknown>>,
    extra?: Readonly<Record<string, unknown>>,
  ) => Effect.Effect<void>;
  /** Writes `text` as it is to the latest reply. */
  readonly write: (text: string) => Effect.Effect<void>;
  /** Writes `[DONE]` and ends the latest reply. */
  readonly done: Effect.Effect<void>;
  /** Ends the latest reply without `[DONE]`. */
  readonly end: Effect.Effect<void>;
  /** Breaks the connection of the latest reply. */
  readonly cut: Effect.Effect<void>;
  /** How many replies their client left before they ended (the request aborted). */
  readonly aborted: () => number;
}

/**
 * A llama-server on loopback for the chat, for the life of the scope: `/health` answers `{"status":"ok"}`, each
 * `POST /v1/chat/completions` gets the headers of an event stream at once, then what the test writes to it.
 */
export const chatStub: Effect.Effect<ChatStub, never, Scope.Scope> = Effect.gen(function* () {
  const bodies: Array<unknown> = [];
  const replies: Array<ServerResponse> = [];
  const cut = new Set<ServerResponse>();
  let aborted = 0;
  const stub = yield* httpStub((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"status":"ok"}');
      return;
    }
    if (req.url !== '/v1/chat/completions' || req.method !== 'POST') {
      res.writeHead(404).end();
      return;
    }
    const chunks: Array<Buffer> = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      bodies.push(JSON.parse(Buffer.concat(chunks).toString()));
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.flushHeaders();
      res.on('close', () => {
        if (!res.writableEnded && !cut.has(res)) aborted++;
      });
      replies.push(res);
    });
  });
  const latest = () => {
    const res = replies.at(-1);
    if (res === undefined) throw new Error('no chat request yet');
    return res;
  };
  const write = (text: string) =>
    Effect.sync(() => {
      latest().write(text);
    });
  return {
    ...stub,
    bodies: () => bodies,
    requested: (n) => until(() => replies.length >= n),
    chunk: (delta, extra = {}) => write(`data: ${JSON.stringify({ choices: [{ index: 0, delta }], ...extra })}\n\n`),
    write,
    done: Effect.sync(() => {
      latest().end('data: [DONE]\n\n');
    }),
    end: Effect.sync(() => {
      latest().end();
    }),
    cut: Effect.sync(() => {
      const res = latest();
      cut.add(res);
      res.destroy();
    }),
    aborted: () => aborted,
  };
});

/** Waits, every 10 ms, until `ok` holds: a test waits on a condition, never on a fixed sleep. */
export const until = (ok: () => boolean): Effect.Effect<void> =>
  Effect.promise(async () => {
    while (!ok()) await new Promise((done) => setTimeout(done, 10));
  });

/** A fake llama-server started outside llama-webui. */
export interface Outside {
  readonly pid: number;
  readonly child: ChildProcess;
}

/** Starts the fake outside llama-webui and waits until its `/health` answers 200. */
async function startOutside(options: {
  readonly port: number;
  readonly env?: Readonly<Record<string, string>>;
}): Promise<{ child: ChildProcess; exited: Promise<void> }> {
  const child = spawn(FAKE, ['--port', String(options.port)], {
    env: { ...process.env, FAKE_LOAD_MS: '0', ...options.env },
    stdio: 'ignore',
  });
  const exited = new Promise<void>((done) => child.once('exit', () => done()));
  for (;;) {
    const status = await fetch(`http://127.0.0.1:${options.port}/health`).then(
      (r) => r.status,
      () => null,
    );
    if (status === 200) return { child, exited };
    if (child.exitCode !== null) throw new Error('the outside fake llama-server exited before it answered');
    await new Promise((done) => setTimeout(done, 20));
  }
}

/**
 * The fake llama-server on `port`, run as a process llama-webui did not start, until it answers `/health` with 200;
 * killed (SIGKILL) and awaited when the scope closes.
 */
export const fakeOutside = (options: {
  readonly port: number;
  readonly env?: Readonly<Record<string, string>>;
}): Effect.Effect<Outside, never, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.promise(() => startOutside(options)),
    ({ child, exited }) => Effect.promise(() => killAndWait(child, exited)),
  ).pipe(Effect.map(({ child }) => ({ pid: child.pid ?? -1, child })));

function killAndWait(child: ChildProcess, exited: Promise<void>): Promise<void> {
  child.kill('SIGKILL');
  return exited;
}

const PROXY_KEYS = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy'];

/** Sets the proxy variables and Node's global agent to `proxy`; answers what puts both back. */
function setProxy(proxy: string): () => void {
  const saved = Object.fromEntries(PROXY_KEYS.map((key) => [key, process.env[key]]));
  for (const key of PROXY_KEYS) delete process.env[key];
  process.env.HTTP_PROXY = proxy;
  process.env.HTTPS_PROXY = proxy;
  process.env.ALL_PROXY = proxy;
  const restoreAgent = setGlobalProxyFromEnv({ http_proxy: proxy, https_proxy: proxy });
  return () => {
    restoreAgent();
    for (const key of PROXY_KEYS) {
      const value = saved[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

/**
 * For the life of the scope, the environment names `proxy` as the proxy of every request (`HTTP_PROXY`, `HTTPS_PROXY`,
 * `ALL_PROXY`, no `NO_PROXY`), and Node's global agent and `fetch` use it; both are restored when it closes.
 */
export const proxiedEnvironment = (proxy: string): Effect.Effect<void, never, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.sync(() => setProxy(proxy)),
    (restore) => Effect.sync(restore),
  ).pipe(Effect.asVoid);

const fetchText = (url: string): Promise<string> => fetch(url).then((r) => r.text());

/** The text Node's own `fetch` gets for `url`: through the proxy of the environment, when one is set. */
export const nodeFetchText = (url: string): Effect.Effect<string> => Effect.promise(() => fetchText(url));

/** Runs `f` after `ms` milliseconds: for the stubs, whose handlers are plain Node callbacks. */
export const later = (ms: number, f: () => void): void => {
  setTimeout(f, ms);
};

/** Sends SIGKILL to `pid`, as something outside llama-webui would. */
export const killFromOutside = (pid: number): Effect.Effect<void> =>
  Effect.sync(() => {
    process.kill(pid, 'SIGKILL');
  });

/** For the life of the scope, llama-webui's own environment holds `name` set to `value`; restored when it closes. */
export const ownVariable = (name: string, value: string): Effect.Effect<void, never, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.sync(() => setVariable(name, value)),
    (restore) => Effect.sync(restore),
  ).pipe(Effect.asVoid);

function setVariable(name: string, value: string): () => void {
  const saved = process.env[name];
  process.env[name] = value;
  return () => {
    if (saved === undefined) delete process.env[name];
    else process.env[name] = saved;
  };
}

/** A JSON request to a running app; a status of 400 or more throws with the reply's text. */
async function call(base: string, method: string, path: string, body?: unknown): Promise<unknown> {
  const res = await fetch(`${base}${path}`, {
    method,
    ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });
  const text = await res.text();
  if (res.status >= 400) throw new Error(`${method} ${path}: ${res.status} ${text}`);
  return text === '' ? undefined : JSON.parse(text);
}

/**
 * A profile of the fake on a free port, started through the API of the app at `base` (the build, `vite dev`), as the
 * web starts one: the `binary` setting set to the fake, the profile created (with `env`, the fake's `FAKE_*`
 * variables), then `/api/server/start`. Resolves with llama-server's pid once the state says `ready` (5 s at most).
 */
export async function startFakeThrough(base: string, env: Record<string, string> = {}): Promise<number> {
  await call(base, 'PATCH', '/api/settings', { binary: FAKE });
  const port = await freePortAsync();
  const profile = (await call(base, 'POST', '/api/profiles', { name: `fake ${port}`, model: 'm.gguf', port, env })) as {
    id: number;
  };
  await call(base, 'POST', '/api/server/start', { profileId: profile.id });
  const t0 = performance.now();
  for (;;) {
    const { state } = (await call(base, 'GET', '/api/server/state')) as { state: { kind: string; pid?: number } };
    if (state.kind === 'ready' && state.pid !== undefined) return state.pid;
    if (performance.now() - t0 > 5000) throw new Error(`llama-server is not ready: ${JSON.stringify(state)}`);
    await new Promise((done) => setTimeout(done, 20));
  }
}
