// The HTTP contract of the app as data: the requests sent to it and how a reply is recorded. Runtime neutral (raw
// HTTP over node:net, see ./wire.ts), so a change of server framework replays it unchanged. Each milestone adds the
// cases of the endpoints it ports; `contract.test.ts` fails while an endpoint of the API definition has none.
import { Api } from '@llama-webui/shared';
import { HttpApi } from 'effect/http-api';
import { readSse, request, type WireRequest, type WireResponse } from './wire.ts';

/**
 * - `read`, `write`: an endpoint used as the web uses it;
 * - `violation`: a payload that breaks the endpoint's schema; `body`: a body the edge refuses; `guard`: a request the
 *   guard refuses; `refusal`: a valid request the domain refuses (a 404 of a missing row, a 409) (all four must fail,
 *   with a status of 400 or more);
 * - `other`: outside the API definition (an unknown path, `/ws` without an upgrade); `web`: the UI's files.
 */
export type CaseKind = 'read' | 'write' | 'violation' | 'refusal' | 'body' | 'guard' | 'other' | 'web';

export interface Case {
  name: string;
  kind: CaseKind;
  req: WireRequest;
  /** Records the status and the headers only: the body is a built file of the client. */
  headOnly?: boolean;
  /** A success depends on the machine (its CPU, its PCI devices): records the names of its fields, not the body. */
  machine?: boolean;
}

/** An endpoint of the API definition: its method, its path (`:param` segments) and whether it takes a body. */
export interface Shape {
  method: string;
  path: string;
  payload: boolean;
}

/** Each endpoint of the API definition, in its order. */
export function shapes(): Shape[] {
  const out: Shape[] = [];
  HttpApi.reflect(Api, {
    onGroup: () => {},
    onEndpoint: ({ endpoint }) =>
      out.push({ method: endpoint.method, path: endpoint.path, payload: endpoint.payload.size > 0 }),
  });
  return out;
}

/** Each endpoint of the API definition, as `METHOD /path`. */
export function endpoints(): string[] {
  return shapes().map((s) => `${s.method} ${s.path}`);
}

/**
 * Whether a request (its path may carry a query string) is a use of `endpoint` (`METHOD /path/:param`): same method,
 * as many segments, a `:param` segment matching one non-empty segment and a literal segment only itself.
 */
export function covers(endpoint: string, req: { method: string; path: string }): boolean {
  const [method, pattern = ''] = endpoint.split(' ');
  if (method !== req.method) return false;
  const want = pattern.split('/');
  const got = (req.path.split('?')[0] ?? '').split('/');
  return want.length === got.length && want.every((seg, i) => (seg.startsWith(':') ? got[i] !== '' : seg === got[i]));
}

const JSON_TYPE = { 'Content-Type': 'application/json' };

/** A request without body, framed as a browser frames it: a POST/PUT/PATCH says `Content-Length: 0`. */
function bare(method: string, path: string, headers: Record<string, string> = {}): WireRequest {
  const empty = method === 'POST' || method === 'PUT' || method === 'PATCH';
  return { method, path, headers: empty ? { ...headers, 'Content-Length': '0' } : headers };
}

const json = (method: string, path: string, body: string, headers: Record<string, string> = {}): WireRequest => ({
  method,
  path,
  headers: { ...JSON_TYPE, ...headers },
  body,
});

/** A hashed file the index page references (`/assets/index-<hash>.js`), found in the page itself. */
export const ASSET = /\/assets\/index-[\w-]{8}\.js/;

/** The llama-server programs the cases set as the `binary` setting. */
export interface Binaries {
  /** `<repo>/testdata/fake/fake-llama-server`: its `--help` lists a few flags. */
  fake: string;
  /** A path in the run's temporary folder where nothing is. */
  missing: string;
}

/** The models folder of the run: the default setting (`~/models`), under the run's home. */
export interface ModelFiles {
  /** `<home>/models/m.gguf`: a small GGUF, the folder's one model. */
  model: string;
  /** A GGUF path in the models folder where nothing is. */
  noModel: string;
  /** A GGUF path outside the models folder that no profile opens: refused before it is looked for. */
  outside: string;
}

/** What the cases name on the disk of the run. */
export type Fixtures = Binaries & ModelFiles;

/** An id no row has: the cases that use it change nothing. */
const UNKNOWN = '999999';
const METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'];

/** `path` with each `:param` segment replaced by `value`. */
const at = (path: string, value: string) =>
  path
    .split('/')
    .map((seg) => (seg.startsWith(':') ? value : seg))
    .join('/');

/**
 * The cases every endpoint gets, from the API definition: each method a path lacks; a bad and an unknown id of each
 * `:param` (an endpoint with a body sends `{}`); the broken bodies of each endpoint that takes one (on an unknown id).
 */
function matrix(add: (kind: CaseKind, name: string, req: WireRequest) => void) {
  const all = shapes();
  for (const path of new Set(all.map((s) => s.path))) {
    const has = new Set(all.filter((s) => s.path === path).map((s) => s.method));
    for (const method of METHODS) {
      if (!has.has(method)) add('other', `${method} ${path} (not an endpoint)`, bare(method, at(path, UNKNOWN)));
    }
  }
  for (const s of all) {
    if (!s.path.includes('/:')) continue;
    const req = (id: string) => (s.payload ? json(s.method, at(s.path, id), '{}') : bare(s.method, at(s.path, id)));
    add('violation', `${s.method} ${s.path} (bad id)`, req('abc'));
    add('refusal', `${s.method} ${s.path} (unknown id)`, req(UNKNOWN));
  }
  for (const s of all) {
    if (!s.payload) continue;
    const path = at(s.path, UNKNOWN);
    const name = (what: string) => `${s.method} ${s.path} (${what})`;
    add('body', name('malformed JSON'), json(s.method, path, '{'));
    // The import takes any JSON (a file of another shape is reported, not refused).
    const anyJson = `${s.method} ${s.path}` === 'POST /api/profiles/import';
    add(anyJson ? 'write' : 'body', name('JSON that is not an object'), json(s.method, path, '1'));
    add('body', name('no body, no content type'), { method: s.method, path, headers: { 'Content-Length': '0' } });
    add('body', name('no body, JSON content type'), {
      method: s.method,
      path,
      headers: { ...JSON_TYPE, 'Content-Length': '0' },
    });
    add('body', name('text/plain'), { method: s.method, path, headers: { 'Content-Type': 'text/plain' }, body: '{}' });
  }
}

/**
 * Every HTTP case, in run order: reads first (llama-server's commands among them), then what changes the settings, then
 * the profiles, then the flag catalogue of a fake llama-server and of one that is not there (so the reply does not
 * depend on the machine's `PATH`), then the bench, the Hub and the downloads, the chat, the models folder, the tuning,
 * and last the matrix of the API definition. `base` is the app's URL, `asset` a hashed file of the build (`ASSET`).
 */
export function cases(ctx: { base: string; asset: string } & Fixtures): Case[] {
  const out: Case[] = [];
  const add = (kind: CaseKind, name: string, req: WireRequest, flags: { headOnly?: true; machine?: true } = {}) =>
    out.push({ kind, name, req, ...flags });

  add('read', 'GET /api/health', bare('GET', '/api/health'));
  add('read', 'GET /api/settings', bare('GET', '/api/settings'));
  add('read', 'GET /api/logs', bare('GET', '/api/logs'));
  add('read', 'GET /api/logs?since=0', bare('GET', '/api/logs?since=0'));
  add('violation', 'GET /api/logs?since=abc (not a line number)', bare('GET', '/api/logs?since=abc'));

  // llama-server: none runs here, and nothing is ever launched (the start and the switch name no profile).
  add('read', 'GET /api/server/state', bare('GET', '/api/server/state'));
  add('read', 'GET /api/state', bare('GET', '/api/state'));
  add('write', 'POST /api/server/stop (nothing runs)', bare('POST', '/api/server/stop'));
  add('refusal', 'POST /api/server/start (no such profile)', json('POST', '/api/server/start', '{"profileId":999}'));
  add('refusal', 'POST /api/server/switch (no such profile)', json('POST', '/api/server/switch', '{"profileId":999}'));
  add(
    'violation',
    'POST /api/server/switch (profileId a string)',
    json('POST', '/api/server/switch', '{"profileId":"1"}'),
  );
  add('refusal', 'POST /api/server/restart (nothing launched)', bare('POST', '/api/server/restart'));
  add('refusal', 'GET /api/server/props (not ready)', bare('GET', '/api/server/props'));
  add('violation', 'POST /api/server/start (no profileId)', json('POST', '/api/server/start', '{}'));
  add(
    'violation',
    'POST /api/server/start (profileId a string)',
    json('POST', '/api/server/start', '{"profileId":"1"}'),
  );

  // The monitoring, on the stub monitor (`LLAMA_WEBUI_TEST_MONITOR=stub`): the machine's own parts by their fields.
  add('read', 'GET /api/monitor/history', bare('GET', '/api/monitor/history'));
  add('read', 'GET /api/monitor/snapshot', bare('GET', '/api/monitor/snapshot'));
  add('read', 'GET /api/system/info', bare('GET', '/api/system/info'), { machine: true });
  add('read', 'GET /api/topology', bare('GET', '/api/topology'), { machine: true });

  // The guard: DNS rebinding (a domain as Host) and another site's page.
  add('guard', 'GET /api/health (foreign Origin)', bare('GET', '/api/health', { Origin: 'http://evil.example' }));
  add('guard', 'GET /api/health (Host evil.example)', bare('GET', '/api/health', { Host: 'evil.example' }));
  add('guard', 'GET /api/health (Host a b)', bare('GET', '/api/health', { Host: 'a b' }));
  add(
    'guard',
    'POST /api/profiles (foreign Origin)',
    json('POST', '/api/profiles', '{"name":"Evil","model":"m"}', { Origin: 'http://evil.example' }),
  );
  // A path the router folds into a route (the case, a repeated slash, a percent escape, a `;`) is guarded as it is.
  add('guard', 'GET /API/settings (foreign Origin)', bare('GET', '/API/settings', { Origin: 'http://evil.example' }));
  add('guard', 'GET //api/settings (Host evil.example)', bare('GET', '//api/settings', { Host: 'evil.example' }));
  add(
    'guard',
    'GET /%61pi/settings (foreign Origin)',
    bare('GET', '/%61pi/settings', { Origin: 'http://evil.example' }),
  );
  add('guard', 'GET /api/settings;x (Host evil.example)', bare('GET', '/api/settings;x', { Host: 'evil.example' }));
  add(
    'guard',
    'POST //api/server/stop (text/plain)',
    json('POST', '//api/server/stop', '{}', { 'Content-Type': 'text/plain' }),
  );
  add('guard', 'GET /WS (foreign Origin)', bare('GET', '/WS', { Origin: 'http://evil.example' }));
  add('guard', 'GET /ws;x (foreign Origin)', bare('GET', '/ws;x', { Origin: 'http://evil.example' }));
  add('guard', 'GET /ws/ (foreign Origin)', bare('GET', '/ws/', { Origin: 'http://evil.example' }));
  // What the guard lets through: the app's own page, a loopback name.
  add('read', 'GET /api/health (same Origin)', bare('GET', '/api/health', { Origin: new URL(ctx.base).origin }));
  add('read', 'GET /api/health (Host localhost)', bare('GET', '/api/health', { Host: 'localhost' }));

  // Outside the API definition.
  add('other', 'GET /api/nope', bare('GET', '/api/nope'));
  add('other', 'GET /api/settings/ (trailing slash)', bare('GET', '/api/settings/'));
  add('other', 'GET /api/settings/?x=1 (trailing slash, query)', bare('GET', '/api/settings/?x=1'));
  add('other', 'GET //api/settings/ (trailing slash, repeated slash)', bare('GET', '//api/settings/'));
  add('other', 'GET /ws (no upgrade)', bare('GET', '/ws'));
  add('other', 'POST /ws (no upgrade)', bare('POST', '/ws'));
  add('other', 'POST /api/nope', bare('POST', '/api/nope'));

  // The UI: the app, a deep URL of it, a hashed file and one that is not there (a stale tab after an upgrade).
  add('web', 'GET / (the app)', bare('GET', '/'));
  add('web', 'GET /chat/12 (deep URL)', bare('GET', '/chat/12'));
  add('web', 'GET /chat/12 (Host evil.example)', bare('GET', '/chat/12', { Host: 'evil.example' }));
  add('web', 'GET /assets/index-<hash>.js (hashed asset)', bare('GET', ctx.asset), { headOnly: true });
  add('web', 'GET /assets/index-00000000.js (missing asset)', bare('GET', '/assets/index-00000000.js'));

  // Writes, last: what a broken payload gets, then a patch that applies.
  add('violation', 'PATCH /api/settings (schema violation)', json('PATCH', '/api/settings', '{"pollIntervalMs":10}'));
  add('write', 'PATCH /api/settings', json('PATCH', '/api/settings', '{"pollIntervalMs":2000}'));

  // The profiles: created, refused, read, changed, copied, exported, imported, deleted, in that order (ids 1, 2…).
  add('read', 'GET /api/profiles (none yet)', bare('GET', '/api/profiles'));
  add(
    'write',
    'POST /api/profiles',
    json(
      'POST',
      '/api/profiles',
      '{"name":"Alpha","model":"/models/a.gguf","port":8081,"args":["-c","4096"],"env":{"A":"1"}}',
    ),
  );
  add(
    'violation',
    'POST /api/profiles (schema violation)',
    json('POST', '/api/profiles', '{"name":"","model":"m","port":70000,"args":["--port","1"],"extra":1}'),
  );
  add('refusal', 'POST /api/profiles (name taken)', json('POST', '/api/profiles', '{"name":"Alpha","model":"m"}'));
  add('read', 'GET /api/profiles/1', bare('GET', '/api/profiles/1'));
  add('write', 'PUT /api/profiles/1', json('PUT', '/api/profiles/1', '{"name":"Alpha 2","model":"/models/a.gguf"}'));
  add('write', 'POST /api/profiles/1/duplicate', bare('POST', '/api/profiles/1/duplicate'));
  add('read', 'GET /api/profiles/1/export', bare('GET', '/api/profiles/1/export'));
  add('read', 'GET /api/profiles/export', bare('GET', '/api/profiles/export'));
  add(
    'write',
    'POST /api/profiles/import',
    json(
      'POST',
      '/api/profiles/import',
      '{"profiles":[{"name":"Beta","model":"/models/b.gguf"},{"name":"bad"},{"name":"Beta","model":"x"},{"name":"Alpha 2","model":"x"}]}',
    ),
  );
  add('write', 'DELETE /api/profiles/2', bare('DELETE', '/api/profiles/2'));
  add('read', 'GET /api/profiles (after the writes)', bare('GET', '/api/profiles'));

  // The flag catalogue: of the fake, then of a binary that is not there.
  const binary = (path: string) => json('PATCH', '/api/settings', `{"binary":${JSON.stringify(path)}}`);
  add('write', 'PATCH /api/settings (binary: the fake llama-server)', binary(ctx.fake));
  add('read', 'GET /api/flags', bare('GET', '/api/flags'));
  add('write', 'PATCH /api/settings (binary: a program that is not there)', binary(ctx.missing));
  add('refusal', 'GET /api/flags (--help fails)', bare('GET', '/api/flags'));

  // The bench, its llama-bench beside the binary that is not there: no device, no run, no sweep; nothing is started
  // (the spec's model is not there).
  add('read', 'GET /api/bench/devices (llama-bench not there)', bare('GET', '/api/bench/devices'));
  add('read', 'GET /api/bench/runs', bare('GET', '/api/bench/runs'));
  add('read', 'GET /api/sweeps', bare('GET', '/api/sweeps'));
  add(
    'violation',
    'POST /api/sweeps/:id/validate (unknown key)',
    json('POST', '/api/sweeps/999999/validate', '{"x":1}'),
  );
  add('violation', 'DELETE /api/bench/runs (no failed=1)', bare('DELETE', '/api/bench/runs'));
  add('write', 'DELETE /api/bench/runs?failed=1 (none)', bare('DELETE', '/api/bench/runs?failed=1'));
  add('violation', 'POST /api/bench/run (no spec)', json('POST', '/api/bench/run', '{}'));
  const spec = {
    kind: 'bench',
    modelPath: ctx.noModel,
    mmprojPath: null,
    profileId: null,
    p: 512,
    n: 128,
    r: 3,
    params: {},
    serverArgs: [],
  };
  add(
    'refusal',
    'POST /api/bench/run (the model is not there)',
    json('POST', '/api/bench/run', JSON.stringify({ spec })),
  );
  add(
    'refusal',
    'POST /api/bench/run (outside the models folder)',
    json('POST', '/api/bench/run', JSON.stringify({ spec: { ...spec, modelPath: ctx.outside } })),
  );

  // The chat: no llama-server runs (a reply is refused before any is asked for). Conversations 1 (no profile: none
  // runs) and 2 (on profile 1), then 2 deleted.
  add('read', 'GET /api/chat (none yet)', bare('GET', '/api/chat'));
  add('write', 'POST /api/chat (no profile: none runs)', json('POST', '/api/chat', '{}'));
  add('write', 'POST /api/chat (profile 1)', json('POST', '/api/chat', '{"profileId":1}'));
  add('violation', 'POST /api/chat (profileId a string)', json('POST', '/api/chat', '{"profileId":"1"}'));
  add('refusal', 'POST /api/chat (no such profile)', json('POST', '/api/chat', '{"profileId":999}'));
  add('read', 'GET /api/chat/1', bare('GET', '/api/chat/1'));
  add(
    'write',
    'PATCH /api/chat/1',
    json(
      'PATCH',
      '/api/chat/1',
      '{"title":"  Renamed  ","systemPrompt":"Be brief.","sampling":{"temperature":0.5},"thinking":false}',
    ),
  );
  add('violation', 'PATCH /api/chat/1 (unknown key)', json('PATCH', '/api/chat/1', '{"nope":1}'));
  add('violation', 'PATCH /api/chat/1 (title a number)', json('PATCH', '/api/chat/1', '{"title":5}'));
  add('refusal', 'PATCH /api/chat/999 (no such conversation)', json('PATCH', '/api/chat/999', '{"title":"x"}'));
  add('read', 'GET /api/chat/1/stream (no reply in progress)', bare('GET', '/api/chat/1/stream'));
  add(
    'refusal',
    'POST /api/chat/1/messages (llama-server not ready)',
    json('POST', '/api/chat/1/messages', '{"content":"Hi"}'),
  );
  add('refusal', 'POST /api/chat/1/messages (blank)', json('POST', '/api/chat/1/messages', '{"content":"  "}'));
  add(
    'violation',
    'POST /api/chat/1/messages (content a number)',
    json('POST', '/api/chat/1/messages', '{"content":5}'),
  );
  add(
    'refusal',
    'POST /api/chat/999/messages (no such conversation)',
    json('POST', '/api/chat/999/messages', '{"content":"Hi"}'),
  );
  add('refusal', 'POST /api/chat/1/regenerate (llama-server not ready)', bare('POST', '/api/chat/1/regenerate'));
  add('refusal', 'POST /api/chat/1/stop (no reply in progress)', bare('POST', '/api/chat/1/stop'));
  add('write', 'DELETE /api/chat/2', bare('DELETE', '/api/chat/2'));
  add('read', 'GET /api/chat (after the writes)', bare('GET', '/api/chat'));

  // The models folder holds one GGUF (`ctx.model`); a profile that opens it, then its usage. Nothing is deleted.
  const query = (path: string) => encodeURIComponent(path);
  add('read', 'GET /api/models', bare('GET', '/api/models'));
  add('read', 'GET /api/models/info', bare('GET', `/api/models/info?path=${query(ctx.model)}`));
  add('violation', 'GET /api/models/info (relative path)', bare('GET', '/api/models/info?path=rel.gguf'));
  add('refusal', 'GET /api/models/info (no such file)', bare('GET', `/api/models/info?path=${query(ctx.noModel)}`));
  add(
    'refusal',
    'GET /api/models/info (outside the models folder)',
    bare('GET', `/api/models/info?path=${query(ctx.outside)}`),
  );
  add(
    'write',
    'POST /api/profiles (opens the model)',
    json('POST', '/api/profiles', '{"name":"Gamma","cwd":"~/models","model":"m.gguf"}'),
  );
  add('read', 'GET /api/models/usage', bare('GET', `/api/models/usage?path=${query(ctx.model)}`));
  add('violation', 'GET /api/models/usage (no path)', bare('GET', '/api/models/usage'));
  add(
    'refusal',
    'GET /api/models/usage (not a model of the folder)',
    bare('GET', `/api/models/usage?path=${query(ctx.noModel)}`),
  );
  add('violation', 'DELETE /api/models (empty path)', json('DELETE', '/api/models', '{"path":""}'));
  add(
    'refusal',
    'DELETE /api/models (not a model of the folder)',
    json('DELETE', '/api/models', JSON.stringify({ path: ctx.noModel })),
  );

  // The tuning and the first run, llama-bench beside the binary that is not there: no device, the estimates plan on
  // the machine's CPU and RAM (its fields only). The folder's model is too small to measure the disk on.
  const files = (path: string) => JSON.stringify({ modelPath: path });
  const sweep = (path: string) =>
    JSON.stringify({
      spec: {
        name: 's',
        modelPath: path,
        mmprojPath: null,
        profileId: null,
        p: 512,
        n: 128,
        r: 3,
        preset: 'chat',
        base: {},
        space: { t: [1, 2] },
        serverArgs: [],
        includeUnfit: false,
      },
    });
  add('read', 'GET /api/tuning/hardware', bare('GET', '/api/tuning/hardware'), { machine: true });
  add('read', 'GET /api/tuning/checks (no model)', bare('GET', '/api/tuning/checks'), { machine: true });
  add('read', 'GET /api/tuning/checks', bare('GET', `/api/tuning/checks?model=${query(ctx.model)}`), { machine: true });
  add(
    'read',
    'POST /api/tuning/estimate',
    json('POST', '/api/tuning/estimate', JSON.stringify({ modelPath: ctx.model, preset: 'fit' })),
    { machine: true },
  );
  add('violation', 'POST /api/tuning/estimate (no model)', json('POST', '/api/tuning/estimate', '{}'));
  add(
    'refusal',
    'POST /api/tuning/estimate (the model is not there)',
    json('POST', '/api/tuning/estimate', JSON.stringify({ modelPath: ctx.noModel, preset: 'fit' })),
  );
  add('read', 'POST /api/tuning/plan', json('POST', '/api/tuning/plan', sweep(ctx.model)), { machine: true });
  add('violation', 'POST /api/tuning/plan (empty spec)', json('POST', '/api/tuning/plan', '{"spec":{}}'));
  add(
    'refusal',
    'POST /api/tuning/plan (the model is not there)',
    json('POST', '/api/tuning/plan', sweep(ctx.noModel)),
  );
  add(
    'refusal',
    'POST /api/tuning/disk-speed (file too small)',
    json('POST', '/api/tuning/disk-speed', files(ctx.model)),
  );
  add(
    'refusal',
    'POST /api/tuning/disk-speed (the model is not there)',
    json('POST', '/api/tuning/disk-speed', files(ctx.noModel)),
  );
  add(
    'violation',
    'POST /api/tuning/disk-speed (empty path)',
    json('POST', '/api/tuning/disk-speed', '{"modelPath":""}'),
  );
  add('violation', 'POST /api/sweeps (empty spec)', json('POST', '/api/sweeps', '{"spec":{}}'));
  add('refusal', 'POST /api/sweeps (the model is not there)', json('POST', '/api/sweeps', sweep(ctx.noModel)));
  add(
    'refusal',
    'POST /api/tuning/estimate (outside the models folder)',
    json('POST', '/api/tuning/estimate', JSON.stringify({ modelPath: ctx.outside, preset: 'fit' })),
  );
  add('refusal', 'POST /api/sweeps (outside the models folder)', json('POST', '/api/sweeps', sweep(ctx.outside)));
  add('read', 'GET /api/setup', bare('GET', '/api/setup'), { machine: true });

  // The Hub: no token, offline (every call to the Hub fails before it leaves: `fetch failed`).
  add('read', 'GET /api/hf/status', bare('GET', '/api/hf/status'));
  add('refusal', 'GET /api/hf/search (offline)', bare('GET', '/api/hf/search?q=qwen'));
  add('violation', 'GET /api/hf/search (blank text)', bare('GET', '/api/hf/search?q=%20'));
  add('refusal', 'GET /api/hf/repo (offline)', bare('GET', '/api/hf/repo?id=org/repo'));
  add('violation', 'GET /api/hf/repo (not an org/name id)', bare('GET', '/api/hf/repo?id=bad'));

  // The download queue: empty, and offline (a request fails at the Hub before anything is queued).
  const download = JSON.stringify({ repo: 'org/repo', revision: '0'.repeat(40), keys: ['m.gguf'] });
  add('read', 'GET /api/downloads (empty)', bare('GET', '/api/downloads'));
  add('refusal', 'POST /api/downloads (offline)', json('POST', '/api/downloads', download));
  add('violation', 'POST /api/downloads (empty repo)', json('POST', '/api/downloads', '{"repo":""}'));
  add('write', 'POST /api/downloads/clear (nothing to clear)', bare('POST', '/api/downloads/clear'));
  add('read', 'GET /api/downloads (after the writes)', bare('GET', '/api/downloads'));

  // Last: the matrix of the API definition (a body the edge refuses must not reach a domain, so nothing it records
  // depends on what ran before).
  matrix(add);

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
  /** Parsed JSON, else text; absent for an empty body, a `headOnly` case or the success of a `machine` case. */
  body?: unknown;
  /** The success of a `machine` case: the sorted names of its fields (`[]` for an array, `null` for a scalar). */
  fields?: string[] | null;
}

/** The headers the contract keeps (others, such as `date` or `content-length`, are framing). */
const KEPT_HEADERS = ['content-type', 'allow', 'cache-control', 'content-disposition', 'location'];

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

/** The names of the fields of a value, sorted: `[]` for an array, `null` for a scalar. */
function fieldsOf(v: unknown): string[] | null {
  if (Array.isArray(v)) return [];
  return v && typeof v === 'object' ? Object.keys(v).sort() : null;
}

export function record(
  res: WireResponse,
  ctx: NormalizeCtx,
  flags: { headOnly?: boolean; machine?: boolean } = {},
): Outcome {
  const headers: Record<string, string> = {};
  for (const h of KEPT_HEADERS) if (res.headers[h] !== undefined) headers[h] = normalize(res.headers[h], ctx) as string;
  const out: Outcome = { status: res.status, headers };
  if (res.body === '' || flags.headOnly) return out;
  let body: unknown = res.body;
  if (/json/.test(res.headers['content-type'] ?? '')) {
    try {
      body = JSON.parse(res.body);
    } catch {
      // kept as text: the contract records what was sent
    }
  }
  if (flags.machine && res.status < 400) out.fields = fieldsOf(body);
  else out.body = normalize(body, ctx);
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
export async function runContract(
  base: string,
  ctx: NormalizeCtx,
  fixtures: Fixtures,
): Promise<Record<string, Outcome>> {
  const out: Record<string, Outcome> = {};
  for (const c of cases({ base, asset: await assetOf(base), ...fixtures }))
    out[c.name] = record(await request(base, c.req), ctx, c);
  return out;
}

/** One server-sent event: its name and its data (JSON when it parses). */
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

async function withTimeout<T>(what: string, p: Promise<T>, ms = 15_000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`contract: ${what} timed out`)), ms);
  });
  try {
    return await Promise.race([p, late]);
  } finally {
    clearTimeout(timer);
  }
}

/** The WebSocket's first frame (hello) and its answer to a ping. */
async function webSocketFrames(base: string): Promise<unknown[]> {
  const ws = new WebSocket(`${base.replace(/^http/, 'ws')}/ws`);
  const frames: unknown[] = [];
  try {
    await withTimeout(
      'the WebSocket hello and pong',
      new Promise<void>((resolve, reject) => {
        ws.onerror = () => reject(new Error('contract: WebSocket error'));
        ws.onmessage = (e) => {
          const frame = JSON.parse(String(e.data)) as { type?: string };
          // A server ping may come between the two: only the hello and the pong are recorded.
          if (frame.type === 'ping') return;
          frames.push(frame);
          if (frames.length === 1) ws.send(JSON.stringify({ type: 'ping' }));
          else resolve();
        };
      }),
    );
  } finally {
    ws.close();
  }
  return frames;
}

/** The `id` of a reply's JSON body (`path` names the object that holds it). */
function idOf(res: WireResponse, ...path: string[]): number {
  let v: unknown = JSON.parse(res.body);
  for (const key of path) v = (v as Record<string, unknown>)[key];
  const id = (v as { id?: unknown }).id;
  if (typeof id !== 'number') throw new Error(`contract: no id in ${res.status} ${res.body}`);
  return id;
}

/**
 * The cases that hold a connection, after the HTTP cases: the WebSocket (hello, ping → pong), then a profile on the
 * folder's model and `livePort`, started on the fake llama-server, its ready state, a conversation on it, the chat's
 * SSE reply (its first event and the name of its last: the deltas depend on timing), and the stop.
 */
export async function runStreams(
  base: string,
  ctx: NormalizeCtx,
  fixtures: Fixtures & { livePort: number },
): Promise<Record<string, Outcome>> {
  const out: Record<string, Outcome> = {};
  const [hello, pong] = await webSocketFrames(base);
  out['WS /ws (hello)'] = { status: 101, headers: {}, body: normalize(hello, ctx) };
  out['WS /ws (ping → pong)'] = { status: 101, headers: {}, body: normalize(pong, ctx) };

  const send = async (name: string, req: WireRequest) => {
    const res = await request(base, req);
    out[name] = record(res, ctx);
    return res;
  };
  await send(
    'PATCH /api/settings (binary: the fake llama-server, for the live cases)',
    json('PATCH', '/api/settings', JSON.stringify({ binary: fixtures.fake })),
  );
  const profile = await send(
    'POST /api/profiles (the live profile)',
    json('POST', '/api/profiles', JSON.stringify({ name: 'Live', model: fixtures.model, port: fixtures.livePort })),
  );
  const profileId = idOf(profile);
  await send(
    'POST /api/server/start (the fake llama-server)',
    json('POST', '/api/server/start', JSON.stringify({ profileId })),
  );
  const ready = await withTimeout(
    'the fake llama-server start',
    (async () => {
      for (;;) {
        const res = await request(base, bare('GET', '/api/server/state'));
        const kind = (JSON.parse(res.body) as { state: { kind: string } }).state.kind;
        if (kind !== 'starting') return res;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    })(),
  );
  out['GET /api/server/state (the fake llama-server ready)'] = record(ready, ctx);
  const conversation = await send(
    'POST /api/chat (on the live profile)',
    json('POST', '/api/chat', JSON.stringify({ profileId })),
  );
  const chatId = idOf(conversation);
  const stream = await withTimeout(
    'the chat SSE reply',
    readSse(base, json('POST', `/api/chat/${chatId}/messages`, '{"content":"Hello"}'), (t) =>
      t.includes('event: done'),
    ),
  );
  const blocks = stream.body.split('\n\n').filter((b) => b.trim() !== '');
  out['POST /api/chat/:id/messages (the SSE reply)'] = {
    ...record({ ...stream, body: '' }, ctx),
    body: { first: sseEvent(blocks[0] ?? '', ctx), last: sseEvent(blocks.at(-1) ?? '', ctx).event },
  };
  await send('POST /api/server/stop (running)', bare('POST', '/api/server/stop'));
  return out;
}
