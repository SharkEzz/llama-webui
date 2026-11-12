import { createServer } from 'node:http';
import { join } from 'node:path';
import { type ChatEvent, type ChatMessage, DEFAULT_SETTINGS, type ServerState, SseParser } from '@llama-webui/shared';
import { expect, test } from 'vitest';
import { MAX_RUNS } from '../db/benchRuns';
import { ConversationsRepo } from '../db/conversations';
import { openDb } from '../db/open';
import { ProfilesRepo } from '../db/profiles';
import { SettingsRepo } from '../db/settings';
import { errorResponse } from '../http';
import { listen } from '../testing/listen';
import { tempDir } from '../testing/tempDir';
import { WsHub, type WsLike } from '../ws/hub';
import { benchRoutes } from './bench';
import { chatRoutes } from './chat';
import { serverRoutes } from './server';
import { settingsRoutes } from './settings';

function chat(chatRuns: unknown = { live: () => undefined }) {
  const dir = tempDir('lw-');
  const db = openDb(join(dir.path, 't.sqlite'));
  const conversations = new ConversationsRepo(db);
  const profiles = new ProfilesRepo(db);
  const p = profiles.create({ name: 'A', model: '/m/a.gguf', args: [], env: {} });
  const app = chatRoutes({
    conversations,
    profiles,
    activeProfileId: () => p.id,
    chatRuns: chatRuns as never,
  });
  app.onError((err) => errorResponse(err));
  return {
    app,
    p,
    [Symbol.dispose]: () => {
      db.close();
      dir[Symbol.dispose]();
    },
  };
}

const post = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

test('POST /api/chat: profileId null records no profile, omitted the active one, a string is a 400 (#37)', async () => {
  using c = chat();
  const create = (body: unknown) => c.app.request('/api/chat', post(body));
  const none = await create({ profileId: null });
  expect(none.status).toBe(201);
  expect(((await none.json()) as { profileId: number | null }).profileId).toBeNull();
  const active = await create({});
  expect(((await active.json()) as { profileId: number | null }).profileId).toBe(c.p.id);
  expect((await create({ profileId: String(c.p.id) })).status).toBe(400);
  expect((await create({ profileId: 999 })).status).toBe(404);
});

test('GET /api/chat/:id/stream is a 404 for a conversation that does not exist, a 204 without a reply (#37)', async () => {
  using c = chat();
  expect((await c.app.request('/api/chat/42/stream')).status).toBe(404);
  const created = (await (await c.app.request('/api/chat', post({}))).json()) as { id: number };
  expect((await c.app.request(`/api/chat/${created.id}/stream`)).status).toBe(204);
});

/** A reply in progress that the test drives: its subscribers and how many have left. */
function liveRun() {
  const listeners = new Set<(e: ChatEvent) => void>();
  const run = {
    left: 0,
    emit: (e: ChatEvent) => {
      for (const l of listeners) l(e);
    },
    subscribe(listener: (e: ChatEvent) => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        run.left++;
      };
    },
    done: Promise.resolve(),
  };
  return run;
}

const message = { id: 1, role: 'assistant', content: 'hi' } as unknown as ChatMessage;

test('GET /api/chat/:id/stream sends the run as SSE events and ends after done', async () => {
  const run = liveRun();
  using c = chat({ live: () => run });
  const created = (await (await c.app.request('/api/chat', post({}))).json()) as { id: number };
  const res = await c.app.request(`/api/chat/${created.id}/stream`);
  expect(res.headers.get('content-type')).toBe('text/event-stream');
  expect(res.headers.get('cache-control')).toBe('no-cache');
  run.emit({ type: 'delta', content: 'h' });
  run.emit({ type: 'done', message });
  expect(new SseParser().push(await res.text())).toEqual([
    { event: 'delta', data: JSON.stringify({ type: 'delta', content: 'h' }) },
    { event: 'done', data: JSON.stringify({ type: 'done', message }) },
  ]);
  expect(run.left).toBe(1);
});

test('GET /api/chat/:id/stream: a client that leaves only unsubscribes', async () => {
  const run = liveRun();
  using c = chat({ live: () => run });
  const created = (await (await c.app.request('/api/chat', post({}))).json()) as { id: number };
  const res = await c.app.request(`/api/chat/${created.id}/stream`);
  await res.body?.cancel();
  await expect.poll(() => run.left).toBe(1);
});

test('/api/server/props: a reply from llama-server that is not JSON is a 502 (#37)', async () => {
  const llama = createServer((_req, res) => res.end('<html>not json</html>'));
  const state: ServerState = { kind: 'external', pid: null, port: Number(new URL(await listen(llama)).port) };
  const app = serverRoutes({
    runtime: { supervisor: { state, lastCommand: null }, logs: null } as never,
    profiles: null!,
    settings: null!,
    benchBusy: () => false,
  });
  app.onError((err) => errorResponse(err));
  const r = await app.request('/api/server/props');
  expect(r.status).toBe(502);
  expect(await r.json()).toEqual({ error: 'llama-server /props: the reply is not JSON' });
  await new Promise((r) => llama.close(r));
});

test('WsHub ignores a frame that parses to something other than an object (#37)', () => {
  const hub = new WsHub('boot', 60_000);
  const sent: string[] = [];
  const ws: WsLike = { send: (d) => void sent.push(d), close() {} };
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
  const app = settingsRoutes({ settings, monitor: { configure } });
  app.onError((err) => errorResponse(err));
  const patch = (body: unknown) =>
    app.request('/api/settings', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
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
  const app = benchRoutes({
    benchRuns: {
      list: (f: { limit?: number }) => {
        limits.push(f.limit);
        return [];
      },
    } as never,
    benchRunner: { live: null } as never,
    sweeps: null!,
    settings: null!,
    profiles: null!,
    hub: null!,
  });
  for (const limit of ['20000', '7000']) await app.request(`/api/bench/runs?limit=${limit}`);
  expect(limits).toEqual([MAX_RUNS, 7000]);
  expect(MAX_RUNS).toBe(10_000);
});
