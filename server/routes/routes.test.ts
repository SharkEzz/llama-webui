import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { DEFAULT_SETTINGS, type ServerState } from '@llama-webui/shared';
import type { ServerWebSocket } from 'bun';
import { MAX_RUNS } from '../db/benchRuns';
import { ConversationsRepo } from '../db/conversations';
import { openDb } from '../db/open';
import { ProfilesRepo } from '../db/profiles';
import { SettingsRepo } from '../db/settings';
import { guarded, withMethodNotAllowed } from '../http';
import { tempDir } from '../testing/tempDir';
import { WsHub } from '../ws/hub';
import { benchRoutes } from './bench';
import { chatRoutes } from './chat';
import { serverRoutes } from './server';
import { settingsRoutes } from './settings';

const ok = () => new Response('ok');
const call = (handler: unknown, req: Request, params: Record<string, string> = {}) =>
  (handler as (r: Request, s: null) => Promise<Response>)(Object.assign(req, { params }), null);

test('a method a route does not define is a 405 with Allow, not the next matching route (#37)', async () => {
  using server = Bun.serve({
    port: 0,
    routes: withMethodNotAllowed({
      '/api/things/import': { POST: guarded(ok) },
      '/api/things/:id': { GET: guarded(() => Response.json({ error: 'Thing not found' }, { status: 404 })) },
      '/api/*': guarded(() => Response.json({ error: 'Unknown route' }, { status: 404 })),
    }),
    // `Handler` may return undefined (a WebSocket upgrade), which Bun only accepts with a websocket handler.
    websocket: { message() {} },
  });
  const r = await fetch(`http://127.0.0.1:${server.port}/api/things/import`);
  expect(r.status).toBe(405);
  expect(r.headers.get('allow')).toBe('POST');
  expect(await r.json()).toEqual({ error: 'Method not allowed (POST)' });
  expect((await fetch(`http://127.0.0.1:${server.port}/api/things/import`, { method: 'POST' })).status).toBe(200);
  expect((await fetch(`http://127.0.0.1:${server.port}/api/nothing`)).status).toBe(404);
});

function chat() {
  const dir = tempDir('lw-');
  const db = openDb(join(dir.path, 't.sqlite'));
  const conversations = new ConversationsRepo(db);
  const profiles = new ProfilesRepo(db);
  const p = profiles.create({ name: 'A', model: '/m/a.gguf', args: [], env: {} });
  const routes = chatRoutes({
    conversations,
    profiles,
    activeProfileId: () => p.id,
    chatRuns: { live: () => null, isLive: () => false } as never,
  });
  return {
    routes,
    p,
    [Symbol.dispose]: () => {
      db.close();
      dir[Symbol.dispose]();
    },
  };
}

const post = (url: string, body: unknown) =>
  new Request(`http://127.0.0.1:7860${url}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

test('POST /api/chat: profileId null records no profile, omitted the active one, a string is a 400 (#37)', async () => {
  using c = chat();
  const create = c.routes['/api/chat'].POST;
  const none = await call(create, post('/api/chat', { profileId: null }));
  expect(none.status).toBe(201);
  expect(((await none.json()) as { profileId: number | null }).profileId).toBeNull();
  const active = await call(create, post('/api/chat', {}));
  expect(((await active.json()) as { profileId: number | null }).profileId).toBe(c.p.id);
  expect((await call(create, post('/api/chat', { profileId: String(c.p.id) }))).status).toBe(400);
  expect((await call(create, post('/api/chat', { profileId: 999 }))).status).toBe(404);
});

test('GET /api/chat/:id/stream is a 404 for a conversation that does not exist, a 204 without a reply (#37)', async () => {
  using c = chat();
  const stream = c.routes['/api/chat/:id/stream'].GET;
  const req = () => new Request('http://127.0.0.1:7860/api/chat/x/stream');
  expect((await call(stream, req(), { id: '42' })).status).toBe(404);
  const created = (await (await call(c.routes['/api/chat'].POST, post('/api/chat', {}))).json()) as { id: number };
  expect((await call(stream, req(), { id: String(created.id) })).status).toBe(204);
});

test('/api/server/props: a reply from llama-server that is not JSON is a 502 (#37)', async () => {
  using llama = Bun.serve({ port: 0, fetch: () => new Response('<html>not json</html>') });
  const state: ServerState = { kind: 'external', pid: null, port: llama.port! };
  const routes = serverRoutes({
    runtime: { supervisor: { state, lastCommand: null }, logs: null } as never,
    profiles: null!,
    settings: null!,
    benchBusy: () => false,
  });
  const r = await call(routes['/api/server/props'].GET, new Request('http://127.0.0.1:7860/api/server/props'));
  expect(r.status).toBe(502);
  expect(await r.json()).toEqual({ error: 'llama-server /props: the reply is not JSON' });
});

test('WsHub ignores a frame that parses to something other than an object (#37)', () => {
  const hub = new WsHub('boot', 60_000);
  const sent: string[] = [];
  const ws = { send: (d: string) => sent.push(d), close() {} } as unknown as ServerWebSocket<unknown>;
  hub.attach(ws);
  for (const frame of ['null', '42', '[]', '"ping"']) expect(() => hub.receive(ws, frame)).not.toThrow();
  hub.receive(ws, '{"type":"ping"}');
  expect(sent.map((s) => (JSON.parse(s) as { type: string }).type)).toEqual(['hello', 'pong']);
  hub.dispose();
});

function settingsApp(configure: () => Promise<void>) {
  const dir = tempDir('lw-');
  const db = openDb(join(dir.path, 't.sqlite'));
  const settings = new SettingsRepo(db);
  const routes = settingsRoutes({ settings, monitor: { configure } });
  const patch = (body: unknown) =>
    call(
      routes['/api/settings'].PATCH,
      new Request('http://127.0.0.1:7860/api/settings', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    );
  return {
    settings,
    patch,
    [Symbol.dispose]: () => {
      db.close();
      dir[Symbol.dispose]();
    },
  };
}

test('PATCH /api/settings merges collectors field by field (#35)', async () => {
  using app = settingsApp(async () => {});
  await app.patch({ collectors: { system: false } });
  const r = await app.patch({ collectors: { nvml: false } });
  expect(r.status).toBe(200);
  expect(app.settings.get().collectors).toEqual({ nvml: false, system: false, disk: true });
});

test('PATCH /api/settings: saved but not applied by the monitor is a 200 with a warning, not a 500 (#35)', async () => {
  using app = settingsApp(async () => {
    throw new Error('NVML init failed');
  });
  const r = await app.patch({ port: 9000 });
  expect(r.status).toBe(200);
  const body = (await r.json()) as { port: number; warning?: string };
  expect(body.port).toBe(9000);
  expect(body.warning).toBe('Saved, but the monitor could not apply it: NVML init failed');
  expect(app.settings.get().port).toBe(9000);
});

test('pollIntervalMs is capped at 60 s (#37)', async () => {
  using app = settingsApp(async () => {});
  expect((await app.patch({ pollIntervalMs: 60_000 })).status).toBe(200);
  expect((await app.patch({ pollIntervalMs: 3_600_000 })).status).toBe(400);
  expect(app.settings.get().pollIntervalMs).toBe(60_000);
  expect(DEFAULT_SETTINGS.pollIntervalMs).toBe(1000);
});

test('GET /api/bench/runs caps an explicit limit at the sweep default, 10,000 (#37)', async () => {
  const limits: (number | undefined)[] = [];
  const routes = benchRoutes({
    benchRuns: {
      list: (f: { limit?: number }) => {
        limits.push(f.limit);
        return [];
      },
    } as never,
    benchRunner: { live: null } as never,
    settings: null!,
    profiles: null!,
    hub: null!,
  });
  for (const limit of ['20000', '7000'])
    await call(routes['/api/bench/runs'].GET, new Request(`http://127.0.0.1:7860/api/bench/runs?limit=${limit}`));
  expect(limits).toEqual([MAX_RUNS, 7000]);
  expect(MAX_RUNS).toBe(10_000);
});
