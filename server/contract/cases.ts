// The HTTP contract of the app as data: every route, the requests sent to it, and how a reply is recorded. Runtime
// neutral (raw HTTP over node:net, see ./wire.ts) so N6 (Hono) and N8 (Node) replay it unchanged.
import { readSse, request, type WireRequest, type WireResponse } from './wire';

export type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
const ALL: readonly (Method | 'HEAD')[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'];

export interface Route {
  path: string;
  methods: Method[];
  /** Methods that read a JSON body, with one body that breaks the route's schema. `lenient`: a JSON value of the
   * wrong shape is answered 200 with what was rejected (profile import), not 400. */
  body?: { methods: Method[]; violation: string; lenient?: boolean };
  /** A success depends on the machine (hardware, /sys, binaries on PATH): record its status, headers and the names
   * of its top-level fields, not their values. */
  machine?: boolean;
  /** Query string of the sample request (the ids of `:id` routes are 1, a seeded row). */
  query?: string;
}

/** The app's routes as `server/app.ts` registers them. `contract.test.ts` checks this list against the app. */
export const ROUTES: Route[] = [
  { path: '/api/health', methods: ['GET'] },
  {
    path: '/api/settings',
    methods: ['GET', 'PATCH'],
    body: { methods: ['PATCH'], violation: '{"pollIntervalMs":10}' },
  },
  { path: '/api/profiles', methods: ['GET', 'POST'], body: { methods: ['POST'], violation: '{"name":""}' } },
  { path: '/api/profiles/export', methods: ['GET'] },
  {
    path: '/api/profiles/import',
    methods: ['POST'],
    body: { methods: ['POST'], violation: '{"profiles":"x"}', lenient: true },
  },
  { path: '/api/profiles/import/llama-tui', methods: ['GET', 'POST'] },
  {
    path: '/api/profiles/:id',
    methods: ['GET', 'PUT', 'DELETE'],
    body: { methods: ['PUT'], violation: '{"name":""}' },
  },
  { path: '/api/profiles/:id/duplicate', methods: ['POST'] },
  { path: '/api/profiles/:id/export', methods: ['GET'] },
  { path: '/api/state', methods: ['GET'] },
  { path: '/api/server/state', methods: ['GET'] },
  { path: '/api/server/start', methods: ['POST'], body: { methods: ['POST'], violation: '{"profileId":"x"}' } },
  { path: '/api/server/switch', methods: ['POST'], body: { methods: ['POST'], violation: '{"profileId":"x"}' } },
  { path: '/api/server/restart', methods: ['POST'] },
  { path: '/api/server/stop', methods: ['POST'] },
  { path: '/api/server/props', methods: ['GET'] },
  { path: '/api/flags', methods: ['GET'], machine: true },
  { path: '/api/logs', methods: ['GET'], query: '?since=0' },
  { path: '/api/monitor/snapshot', methods: ['GET'] },
  { path: '/api/monitor/history', methods: ['GET'] },
  { path: '/api/system/info', methods: ['GET'], machine: true },
  { path: '/api/models', methods: ['GET', 'DELETE'], body: { methods: ['DELETE'], violation: '{"path":""}' } },
  { path: '/api/models/usage', methods: ['GET'], query: '?path=<tmp>/models/m.gguf' },
  { path: '/api/models/info', methods: ['GET'], query: '?path=<tmp>/models/m.gguf' },
  { path: '/api/hf/status', methods: ['GET'] },
  { path: '/api/hf/search', methods: ['GET'], query: '?q=qwen' },
  { path: '/api/hf/repo', methods: ['GET'], query: '?id=org/repo' },
  { path: '/api/downloads', methods: ['GET', 'POST'], body: { methods: ['POST'], violation: '{"repo":""}' } },
  { path: '/api/downloads/clear', methods: ['POST'] },
  { path: '/api/downloads/:id', methods: ['DELETE'] },
  { path: '/api/downloads/:id/retry', methods: ['POST'] },
  { path: '/api/chat', methods: ['GET', 'POST'], body: { methods: ['POST'], violation: '{"profileId":"1"}' } },
  {
    path: '/api/chat/:id',
    methods: ['GET', 'PATCH', 'DELETE'],
    body: { methods: ['PATCH'], violation: '{"title":5}' },
  },
  { path: '/api/chat/:id/messages', methods: ['POST'], body: { methods: ['POST'], violation: '{"content":5}' } },
  { path: '/api/chat/:id/regenerate', methods: ['POST'] },
  { path: '/api/chat/:id/stop', methods: ['POST'] },
  { path: '/api/chat/:id/stream', methods: ['GET'] },
  { path: '/api/bench/runs', methods: ['GET', 'DELETE'] },
  { path: '/api/bench/run', methods: ['POST'], body: { methods: ['POST'], violation: '{"spec":{}}' } },
  { path: '/api/bench/devices', methods: ['GET'], machine: true },
  { path: '/api/bench/:id', methods: ['DELETE'] },
  { path: '/api/bench/from-profile/:id', methods: ['GET'] },
  { path: '/api/bench/:id/to-profile', methods: ['POST'] },
  { path: '/api/bench/:id/cancel', methods: ['POST'] },
  { path: '/api/sweeps', methods: ['GET', 'POST'], body: { methods: ['POST'], violation: '{"spec":{}}' } },
  { path: '/api/sweeps/:id', methods: ['GET', 'DELETE'] },
  { path: '/api/sweeps/:id/cancel', methods: ['POST'] },
  {
    path: '/api/sweeps/:id/resume',
    methods: ['POST'],
    body: { methods: ['POST'], violation: '{"stopServer":"x"}' },
  },
  { path: '/api/sweeps/:id/validate', methods: ['POST'], body: { methods: ['POST'], violation: '{"n":0}' } },
  { path: '/api/tuning/hardware', methods: ['GET'], machine: true },
  { path: '/api/tuning/estimate', methods: ['POST'], body: { methods: ['POST'], violation: '{}' } },
  { path: '/api/tuning/plan', methods: ['POST'], body: { methods: ['POST'], violation: '{"spec":{}}' } },
  { path: '/api/tuning/checks', methods: ['GET'], machine: true },
  {
    path: '/api/tuning/disk-speed',
    methods: ['POST'],
    body: { methods: ['POST'], violation: '{"modelPath":""}' },
  },
  { path: '/api/topology', methods: ['GET'], machine: true },
  { path: '/api/setup', methods: ['GET'], machine: true },
  { path: '/api/launchpad', methods: ['GET'], machine: true },
];

export type CaseKind = 'method' | 'id' | 'body' | 'violation' | 'lenient' | 'guard' | 'other' | 'web';

export interface Case {
  name: string;
  kind: CaseKind;
  req: WireRequest;
  machine?: boolean;
}

const JSON_TYPE = { 'Content-Type': 'application/json' };

/** A request without body, framed as a browser frames it: a POST/PUT/PATCH says `Content-Length: 0`, a GET/DELETE
 * says nothing. */
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

const sample = (r: Route, id = '1') => r.path.replace(':id', id);

/**
 * Every HTTP case, in run order. Reads come first; the cases that change rows (the web's body-less calls) run last,
 * on rows seeded for them (profile 2, conversation 2, bench run 2, sweep 2).
 */
export function cases(ctx: { tmp: string; port: number }): Case[] {
  const out: Case[] = [];
  const add = (kind: CaseKind, name: string, req: WireRequest, machine?: boolean) =>
    out.push({ kind, name, req, ...(machine ? { machine } : {}) });
  const q = (r: Route) => (r.query ?? '').replace('<tmp>', ctx.tmp);

  // Each path: the methods it lacks are 405s (with Allow); HEAD on every path; GETs as a read.
  for (const r of ROUTES) {
    const path = sample(r) + q(r);
    for (const m of ALL) {
      if (m !== 'HEAD' && r.methods.includes(m)) continue;
      add('method', `${m} ${r.path}`, bare(m, path), r.machine);
    }
    if (r.methods.includes('GET')) add('method', `GET ${r.path}`, bare('GET', path), r.machine);
  }

  // Ids: not a number, and a number no row has. A body route gets a valid-looking body so the id decides.
  for (const r of ROUTES.filter((x) => x.path.includes(':id'))) {
    for (const [label, id] of [
      ['bad id', 'x'],
      ['unknown id', '999999'],
    ] as const) {
      for (const m of r.methods) {
        const path = sample(r, id);
        const req =
          r.body?.methods.includes(m) || (m !== 'GET' && m !== 'DELETE') ? json(m, path, '{}') : bare(m, path);
        add('id', `${m} ${r.path} (${label})`, req);
      }
    }
  }

  // Body routes: what a broken or missing body gets.
  for (const r of ROUTES.filter((x) => x.body)) {
    const path = sample(r);
    for (const m of r.body!.methods) {
      add('body', `${m} ${r.path} (malformed JSON)`, json(m, path, '{'));
      const shape = r.body!.lenient ? 'lenient' : 'body';
      add(shape, `${m} ${r.path} (non-object JSON)`, json(m, path, '[1]'));
      add('body', `${m} ${r.path} (no body, no content-type)`, bare(m, path));
      add('body', `${m} ${r.path} (no body, JSON content-type)`, bare(m, path, JSON_TYPE));
      add('body', `${m} ${r.path} (text/plain)`, {
        method: m,
        path,
        headers: { 'Content-Type': 'text/plain' },
        body: '{}',
      });
      add(
        shape === 'lenient' ? shape : 'violation',
        `${m} ${r.path} (schema violation)`,
        json(m, path, r.body!.violation),
      );
    }
  }

  // Host and Origin: DNS rebinding and cross-site requests.
  const self = `http://127.0.0.1:${ctx.port}`;
  add('guard', 'GET /api/health (foreign Origin)', bare('GET', '/api/health', { Origin: 'http://evil.example' }));
  add('guard', 'GET /api/health (same Origin)', bare('GET', '/api/health', { Origin: self }));
  add('guard', 'GET /api/health (Host evil.example)', bare('GET', '/api/health', { Host: 'evil.example' }));
  add('guard', 'GET /api/health (Host a b)', bare('GET', '/api/health', { Host: 'a b' }));
  add('guard', 'GET /api/health (Host localhost)', bare('GET', '/api/health', { Host: `localhost:${ctx.port}` }));
  add('guard', 'POST /api/profiles (foreign Origin)', {
    ...json('POST', '/api/profiles', '{"name":"x","model":"/m.gguf"}'),
    headers: { ...JSON_TYPE, Origin: 'http://evil.example' },
  });
  add('guard', 'GET /chat/12 (Host evil.example)', bare('GET', '/chat/12', { Host: 'evil.example' }));

  // Outside the route table.
  add('other', 'GET /api/nope', bare('GET', '/api/nope'));
  add('other', 'POST /api/nope', json('POST', '/api/nope', '{}'));
  add('other', 'GET /chat/12 (deep SPA URL)', bare('GET', '/chat/12'));
  add('other', 'GET / (the app)', bare('GET', '/'));
  add('other', 'GET /ws (no upgrade)', bare('GET', '/ws'));
  add('other', 'POST /ws (no upgrade)', bare('POST', '/ws'));

  // The web's own calls that change rows, as it sends them (body-less, or `{}`).
  add('web', 'DELETE /api/bench/runs?failed=1', bare('DELETE', '/api/bench/runs?failed=1'));
  add('web', 'DELETE /api/bench/runs (no failed=1)', bare('DELETE', '/api/bench/runs'));
  add('web', 'POST /api/bench/1/cancel', bare('POST', '/api/bench/1/cancel'));
  add('web', 'POST /api/sweeps/1/cancel', bare('POST', '/api/sweeps/1/cancel'));
  add('web', 'POST /api/chat/1/stop', json('POST', '/api/chat/1/stop', '{}'));
  add('web', 'POST /api/downloads/clear', json('POST', '/api/downloads/clear', '{}'));
  add('web', 'POST /api/downloads/999999/retry', json('POST', '/api/downloads/999999/retry', '{}'));
  add('web', 'DELETE /api/downloads/999999', bare('DELETE', '/api/downloads/999999'));
  add('web', 'POST /api/server/restart', bare('POST', '/api/server/restart'));
  add('web', 'POST /api/server/stop', bare('POST', '/api/server/stop'));
  add('web', 'POST /api/profiles/import/llama-tui', bare('POST', '/api/profiles/import/llama-tui'));
  add('web', 'DELETE /api/profiles/2', bare('DELETE', '/api/profiles/2'));
  add('web', 'DELETE /api/chat/2', bare('DELETE', '/api/chat/2'));
  add('web', 'DELETE /api/bench/2', bare('DELETE', '/api/bench/2'));
  add('web', 'DELETE /api/sweeps/2', bare('DELETE', '/api/sweeps/2'));
  add('web', 'POST /api/profiles/1/duplicate', bare('POST', '/api/profiles/1/duplicate'));
  add('web', 'POST /api/bench/1/to-profile', json('POST', '/api/bench/1/to-profile', '{}'));
  add('web', 'GET /api/profiles (after the changes)', bare('GET', '/api/profiles'));

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
  /** Parsed JSON, else text; absent for an empty body. */
  body?: unknown;
  /** A machine-dependent success: the names of its top-level fields (`[]` for an array, `null` for a scalar). */
  fields?: string[] | null;
}

/** The headers the contract keeps (others, such as `date` or `content-length`, are framing). */
const KEPT_HEADERS = ['content-type', 'allow', 'cache-control', 'content-disposition'];

export interface NormalizeCtx {
  /** Temporary directory of the run (data dir, models, home). */
  tmp: string;
  /** Repository root (the fake binaries' paths). */
  repo: string;
  /** `os.homedir()`: Bun does not follow a `HOME` changed at run time, Node does. */
  home: string;
  /** Ports that change from run to run (the app's, llama-server's). */
  ports: number[];
}

/** Keys whose value changes from run to run. */
const VOLATILE_KEYS = new Set(['version', 'uptimeMs', 'pid', 'bootId']);
const EPOCH_MS = (n: number) => Number.isInteger(n) && n > 1.5e12 && n < 4e12;
const ISO_TIME = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

/** Replaces what changes between runs (times, ports, temporary paths, ids of the boot) with placeholders. */
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
    return s.replace(ISO_TIME, '<time>').replace(UUID, '<uuid>');
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

function fieldsOf(v: unknown): string[] | null {
  if (Array.isArray(v)) return [];
  return v && typeof v === 'object' ? Object.keys(v).sort() : null;
}

export function record(res: WireResponse, ctx: NormalizeCtx, machine = false): Outcome {
  const headers: Record<string, string> = {};
  for (const h of KEPT_HEADERS) if (res.headers[h] !== undefined) headers[h] = normalize(res.headers[h], ctx) as string;
  const out: Outcome = { status: res.status, headers };
  if (res.body === '') return out;
  let body: unknown = res.body;
  if (/json/.test(res.headers['content-type'] ?? '')) {
    try {
      body = JSON.parse(res.body);
    } catch {
      // kept as text: the contract records what was sent
    }
  }
  if (machine && res.status < 400) out.fields = fieldsOf(body);
  else out.body = normalize(body, ctx);
  return out;
}

/** Runs every HTTP case against `base`, one after the other; the keys are the case names, in run order. */
export async function runContract(
  base: string,
  ctx: NormalizeCtx & { port: number },
): Promise<Record<string, Outcome>> {
  const out: Record<string, Outcome> = {};
  for (const c of cases(ctx)) out[c.name] = record(await request(base, c.req), ctx, c.machine);
  return out;
}

/** One SSE event of a stream: its name and its data (JSON when it parses). */
function sseEvent(block: string, ctx: NormalizeCtx): { event: string | null; data: unknown } {
  const field = (name: string) =>
    block
      .split('\n')
      .filter((l) => l.startsWith(`${name}: `))
      .map((l) => l.slice(name.length + 2))
      .join('\n');
  const raw = field('data');
  let data: unknown = raw;
  try {
    data = JSON.parse(raw);
  } catch {
    // kept as text
  }
  return { event: field('event') || null, data: normalize(data, ctx) };
}

function withTimeout<T>(p: Promise<T>, what: string, ms = 15_000): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`contract: ${what} timed out`)), ms)),
  ]);
}

/** The WebSocket's first frame (hello) and its reply to a ping. */
async function webSocketFrames(base: string): Promise<unknown[]> {
  const ws = new WebSocket(`${base.replace(/^http/, 'ws')}/ws`);
  const frames: unknown[] = [];
  try {
    await withTimeout(
      new Promise<void>((resolve, reject) => {
        ws.onerror = () => reject(new Error('contract: WebSocket error'));
        ws.onmessage = (e) => {
          frames.push(JSON.parse(String(e.data)));
          if (frames.length === 1) ws.send(JSON.stringify({ type: 'ping' }));
          else resolve();
        };
      }),
      'WebSocket hello/pong',
    );
  } finally {
    ws.close();
  }
  return frames;
}

/**
 * Cases that hold a connection: the WebSocket (hello, ping → pong) and the chat's SSE stream against the fake
 * llama-server (profile 1). Run after `runContract`, so they change nothing it records.
 */
export async function runStreams(base: string, ctx: NormalizeCtx): Promise<Record<string, Outcome>> {
  const out: Record<string, Outcome> = {};
  const [hello, pong] = await webSocketFrames(base);
  out['WS /ws (hello)'] = { status: 101, headers: {}, body: normalize(hello, ctx) };
  out['WS /ws (ping → pong)'] = { status: 101, headers: {}, body: normalize(pong, ctx) };

  out['POST /api/server/start (fake server)'] = record(
    await request(base, json('POST', '/api/server/start', '{"profileId":1}')),
    ctx,
  );
  const ready = await withTimeout(
    (async () => {
      for (;;) {
        const res = await request(base, bare('GET', '/api/server/state'));
        const kind = (JSON.parse(res.body) as { state: { kind: string } }).state.kind;
        if (kind !== 'starting') return res;
        await new Promise((r) => setTimeout(r, 100));
      }
    })(),
    'fake llama-server start',
  );
  out['GET /api/server/state (fake server ready)'] = record(ready, ctx);

  // The whole stream is read (up to `done`), the first event is recorded: deltas depend on timing.
  const stream = await withTimeout(
    readSse(base, json('POST', '/api/chat/1/messages', '{"content":"Hello"}'), (t) => t.includes('event: done')),
    'chat SSE stream',
  );
  const blocks = stream.body.split('\n\n').filter((b) => b.trim() !== '');
  const sse = record({ ...stream, body: '' }, ctx);
  out['POST /api/chat/1/messages (SSE)'] = {
    ...sse,
    body: { first: sseEvent(blocks[0] ?? '', ctx), last: sseEvent(blocks.at(-1) ?? '', ctx).event },
  };

  out['POST /api/server/stop (running)'] = record(await request(base, bare('POST', '/api/server/stop')), ctx);
  return out;
}

export { readSse };
