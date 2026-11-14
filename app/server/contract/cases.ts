// The HTTP contract of the app as data: the requests sent to it and how a reply is recorded. Runtime neutral (raw
// HTTP over node:net, see ./wire.ts), so a change of server framework replays it unchanged. Each milestone adds the
// cases of the endpoints it ports; `contract.test.ts` fails while an endpoint of the API definition has none.
import { Api } from '@llama-webui/shared';
import { HttpApi } from 'effect/http-api';
import { request, type WireRequest, type WireResponse } from './wire.ts';

/**
 * - `read`, `write`: an endpoint used as the web uses it;
 * - `violation`: a payload that breaks the endpoint's schema; `body`: a body the edge refuses; `guard`: a request the
 *   guard refuses (all three must fail, with a status of 400 or more);
 * - `other`: outside the API definition (an unknown path, `/ws` without an upgrade); `web`: the UI's files.
 */
export type CaseKind = 'read' | 'write' | 'violation' | 'body' | 'guard' | 'other' | 'web';

export interface Case {
  name: string;
  kind: CaseKind;
  req: WireRequest;
  /** Records the status and the headers only: the body is a built file of the client. */
  headOnly?: boolean;
}

/** Each endpoint of the API definition, as `METHOD /path`. */
export function endpoints(): string[] {
  const out: string[] = [];
  HttpApi.reflect(Api, {
    onGroup: () => {},
    onEndpoint: ({ endpoint }) => out.push(`${endpoint.method} ${endpoint.path}`),
  });
  return out;
}

const JSON_TYPE = { 'Content-Type': 'application/json' };

/** A request without body, framed as a browser frames it: a POST/PUT/PATCH says `Content-Length: 0`. */
function bare(method: string, path: string, headers: Record<string, string> = {}): WireRequest {
  const empty = method === 'POST' || method === 'PUT' || method === 'PATCH';
  return { method, path, headers: empty ? { ...headers, 'Content-Length': '0' } : headers };
}

const json = (method: string, path: string, body: string): WireRequest => ({
  method,
  path,
  headers: JSON_TYPE,
  body,
});

/** A hashed file the index page references (`/assets/index-<hash>.js`), found in the page itself. */
export const ASSET = /\/assets\/index-[\w-]{8}\.js/;

/**
 * Every HTTP case, in run order: reads first, then what changes the settings. `asset` is the path of a hashed file of
 * the build (`ASSET`).
 */
export function cases(ctx: { asset: string }): Case[] {
  const out: Case[] = [];
  const add = (kind: CaseKind, name: string, req: WireRequest, headOnly = false) =>
    out.push({ kind, name, req, ...(headOnly ? { headOnly } : {}) });

  add('read', 'GET /api/health', bare('GET', '/api/health'));
  add('read', 'GET /api/settings', bare('GET', '/api/settings'));

  // The guard: DNS rebinding (a domain as Host) and another site's page.
  add('guard', 'GET /api/health (foreign Origin)', bare('GET', '/api/health', { Origin: 'http://evil.example' }));
  add('guard', 'GET /api/health (Host evil.example)', bare('GET', '/api/health', { Host: 'evil.example' }));

  // Outside the API definition.
  add('other', 'GET /api/nope', bare('GET', '/api/nope'));
  add('other', 'GET /api/settings/ (trailing slash)', bare('GET', '/api/settings/'));
  add('other', 'DELETE /api/health (a method the path lacks)', bare('DELETE', '/api/health'));
  add('other', 'HEAD /api/health', bare('HEAD', '/api/health'));
  add('other', 'GET /ws (no upgrade)', bare('GET', '/ws'));

  // The UI: the app, a deep URL of it, a hashed file and one that is not there (a stale tab after an upgrade).
  add('web', 'GET / (the app)', bare('GET', '/'));
  add('web', 'GET /chat/12 (deep URL)', bare('GET', '/chat/12'));
  add('web', 'GET /assets/index-<hash>.js (hashed asset)', bare('GET', ctx.asset), true);
  add('web', 'GET /assets/index-00000000.js (missing asset)', bare('GET', '/assets/index-00000000.js'));

  // Writes, last: what a broken payload gets, then a patch that applies.
  add('body', 'PATCH /api/settings (text/plain)', {
    method: 'PATCH',
    path: '/api/settings',
    headers: { 'Content-Type': 'text/plain' },
    body: '{}',
  });
  add('body', 'PATCH /api/settings (malformed JSON)', json('PATCH', '/api/settings', '{'));
  add('violation', 'PATCH /api/settings (schema violation)', json('PATCH', '/api/settings', '{"pollIntervalMs":10}'));
  add('write', 'PATCH /api/settings', json('PATCH', '/api/settings', '{"pollIntervalMs":2000}'));

  const names = new Set<string>();
  for (const c of out) {
    if (names.has(c.name)) throw new Error(`duplicate contract case: ${c.name}`);
    names.add(c.name);
  }
  return out;
}

export interface Outcome {
  status: number;
  headers: Record<string, string>;
  /** Parsed JSON, else text; absent for an empty body or a `headOnly` case. */
  body?: unknown;
}

/** The headers the contract keeps (others, such as `date` or `content-length`, are framing). */
const KEPT_HEADERS = ['content-type', 'allow', 'cache-control', 'content-disposition'];

export interface NormalizeCtx {
  /** Temporary directory of the run (data dir, home). */
  tmp: string;
  /** Repository root. */
  repo: string;
  /** The server's home. */
  home: string;
  /** Ports that change from run to run (the app's). */
  ports: number[];
}

/** Keys whose value changes from run to run. */
const VOLATILE_KEYS = new Set(['version', 'uptimeMs', 'pid', 'bootId']);
const EPOCH_MS = (n: number) => Number.isInteger(n) && n > 1.5e12 && n < 4e12;
const ISO_TIME = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
/** A built asset's content hash (`/assets/index-DopSxb7D.js`): changes with any change to the client. */
const ASSET_HASH = /(?<=\/assets\/[\w.-]+?-)[\w-]{8}(?=\.(?:js|css|svg)\b)/g;

/**
 * Replaces what changes between runs (times, ports, temporary paths, ids of the boot) or between builds (asset hashes)
 * with placeholders.
 */
export function normalize(v: unknown, ctx: NormalizeCtx): unknown {
  if (typeof v === 'string') {
    // Longest first: one of these paths may contain another.
    const paths: [string, string][] = [
      [ctx.tmp, '<tmp>'],
      [ctx.repo, '<repo>'],
      [ctx.home, '<home>'],
    ];
    let s = v;
    for (const [path, tag] of paths.sort((a, b) => b[0].length - a[0].length)) s = s.split(path).join(tag);
    for (const p of ctx.ports) s = s.replace(new RegExp(`(?<=[:= ])${p}(?!\\d)`, 'g'), '<port>');
    return s.replace(ISO_TIME, '<time>').replace(UUID, '<uuid>').replace(ASSET_HASH, '<hash>');
  }
  if (typeof v === 'number') return EPOCH_MS(v) ? '<time>' : ctx.ports.includes(v) ? '<port>' : v;
  if (Array.isArray(v)) return v.map((x) => normalize(x, ctx));
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[k] = VOLATILE_KEYS.has(k) && x !== null ? `<${k}>` : normalize(x, ctx);
    return out;
  }
  return v;
}

export function record(res: WireResponse, ctx: NormalizeCtx, headOnly = false): Outcome {
  const headers: Record<string, string> = {};
  for (const h of KEPT_HEADERS) if (res.headers[h] !== undefined) headers[h] = normalize(res.headers[h], ctx) as string;
  const out: Outcome = { status: res.status, headers };
  if (res.body === '' || headOnly) return out;
  let body: unknown = res.body;
  if (/json/.test(res.headers['content-type'] ?? '')) {
    try {
      body = JSON.parse(res.body);
    } catch {
      // kept as text: the contract records what was sent
    }
  }
  out.body = normalize(body, ctx);
  return out;
}

/** The hashed file the app's page references (`ASSET`). */
export async function assetOf(base: string): Promise<string> {
  const page = await request(base, bare('GET', '/'));
  const asset = ASSET.exec(page.body)?.[0];
  if (asset === undefined) throw new Error(`contract: the page references no ${ASSET}:\n${page.body}`);
  return asset;
}

/** Runs every HTTP case against `base`, one after the other; the keys are the case names, in run order. */
export async function runContract(base: string, ctx: NormalizeCtx): Promise<Record<string, Outcome>> {
  const out: Record<string, Outcome> = {};
  for (const c of cases({ asset: await assetOf(base) }))
    out[c.name] = record(await request(base, c.req), ctx, c.headOnly);
  return out;
}
