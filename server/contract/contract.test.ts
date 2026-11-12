// HTTP contract of the app: every case of ./cases.ts over real HTTP against the real createApp, compared with
// golden.json. `UPDATE_GOLDEN=1 bun test ./server/contract/contract.test.ts` rewrites the golden (review its diff).
// On bun:test until N8: it boots Bun.serve (BUN_ONLY in vitest.config.ts).
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { BenchSpecSchema, SweepSpecSchema } from '@llama-webui/shared';
import { appRoutes, createApp } from '../app';
import { BenchGate } from '../bench/gate';
import { BenchRunsRepo } from '../db/benchRuns';
import { ConversationsRepo } from '../db/conversations';
import { openDb } from '../db/open';
import { ProfilesRepo } from '../db/profiles';
import { SettingsRepo } from '../db/settings';
import { SweepsRepo } from '../db/sweeps';
import { createDeps } from '../deps';
import { LogBuffer } from '../logs/buffer';
import { writeGguf } from '../models/gguf.fixture';
import type { Monitor } from '../monitor/monitor';
import type { Runtime } from '../runtime';
import { Supervisor } from '../supervisor/supervisor';
import { tempDir } from '../testing/tempDir';
import { cases, type Outcome, ROUTES, runContract, runStreams } from './cases';

const GOLDEN = join(import.meta.dirname, 'golden.json');
const REPO = resolve(import.meta.dirname, '../..');
const FAKE_SERVER = join(REPO, 'testdata/fake/fake-llama-server');

/** Environment read by the routes (home, llama-tui config, Hugging Face token): pointed into the temp dir. */
const ENV_KEYS = [
  'HOME',
  'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME',
  'HF_HOME',
  'HF_TOKEN',
  'HF_TOKEN_PATH',
  'HUGGING_FACE_HUB_TOKEN',
  'HF_ENDPOINT',
  'FAKE_CHAT_DELAY_MS',
] as const;

async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const port = (s.address() as { port: number }).port;
  await new Promise((r) => s.close(r));
  return port;
}

/** The monitor without collectors: no snapshot yet, an empty history. */
const stubMonitor = {
  latest: () => null,
  dump: () => ({ intervalMs: 1000, capacity: 0, at: 0, times: [], series: {} }),
  configure: async () => {},
  nvidiaSource: 'nvml',
  nvmlSystem: null,
  onSnapshot: () => () => {},
  setModelPathResolver: () => {},
} as unknown as Monitor;

async function boot() {
  const dir = tempDir('lw-contract-');
  const tmp = dir.path;
  const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.HOME = join(tmp, 'home');
  // Outside HOME: Bun's homedir() ignores this HOME (`<home>` in the golden), Node's follows it.
  process.env.XDG_CONFIG_HOME = join(tmp, 'xdg-config');
  process.env.XDG_CACHE_HOME = join(tmp, 'xdg-cache');
  // The fake llama-server inherits the environment: no pause between chat chunks, so the stream ends at once.
  process.env.FAKE_CHAT_DELAY_MS = '0';
  await mkdir(join(tmp, 'home'), { recursive: true });

  const modelsDir = join(tmp, 'models');
  const model = join(modelsDir, 'm.gguf');
  await mkdir(modelsDir, { recursive: true });
  await writeGguf(
    model,
    { 'general.architecture': { type: 'string', value: 'llama' }, 'llama.block_count': { type: 'u32', value: 1 } },
    [{ name: 'token_embd.weight', shape: [8, 4], bytes: 128 }],
  );

  // Seeded rows: id 1 is read, id 2 is deleted by the web's body-less calls (run last).
  const db = openDb(join(tmp, 'llama-webui.sqlite'));
  const llamaPort = await freePort();
  new SettingsRepo(db).patch({ binary: FAKE_SERVER, modelsDir, port: llamaPort });
  const profiles = new ProfilesRepo(db);
  const conversations = new ConversationsRepo(db);
  const benchRuns = new BenchRunsRepo(db);
  const sweeps = new SweepsRepo(db);
  const hw = { cpu: '', gpus: [], build: null };
  for (const name of ['A', 'B']) {
    const p = profiles.create({ name, model, args: [], env: {} });
    conversations.create({ profileId: p.id, modelPath: model });
    const run = benchRuns.create(BenchSpecSchema.parse({ kind: 'bench', modelPath: model }), 'llama-bench', hw);
    benchRuns.finish(run.id, { status: 'ok', tg: { tps: 50, stddev: 0, tokens: 128 } });
    const sweep = sweeps.create(
      SweepSpecSchema.parse({ name: `s${name}`, modelPath: model, preset: 'chat', space: { ncmoe: [0, 8] } }),
    );
    sweeps.setStatus(sweep.id, 'done', { finishedAt: Date.now() });
  }

  // Own runtime: getRuntime() is a global and installs signal handlers.
  const logs = new LogBuffer(10_000);
  const supervisor = new Supervisor({ logs });
  const runtime: Runtime = {
    supervisor,
    logs,
    bootId: 'contract',
    monitor: null,
    benchGate: new BenchGate({ server: supervisor, logs }),
  };
  const deps = createDeps({
    db,
    runtime,
    monitor: stubMonitor,
    web: {
      '/*': new Response('<!doctype html><title>llama-webui</title>', {
        headers: { 'Content-Type': 'text/html;charset=utf-8', 'Cache-Control': 'no-cache' },
      }),
    },
    hostname: '127.0.0.1',
    port: 0,
    development: false,
    // No network: Hugging Face Hub and CDN requests fail as offline.
    fetch: (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch,
  });
  const server = createApp(deps);
  const port = server.port as number;
  return {
    base: `http://127.0.0.1:${port}`,
    ctx: { tmp, repo: REPO, home: homedir(), ports: [port, llamaPort], port },
    deps,
    async dispose() {
      await server.stop(true);
      deps.chatRuns.dispose();
      deps.benchRunner.dispose({ restart: false });
      deps.downloads.dispose();
      deps.placement.dispose();
      deps.hub.dispose();
      await supervisor.stop();
      db.close();
      dir[Symbol.dispose]();
      for (const k of ENV_KEYS) {
        if (savedEnv[k] === undefined) delete process.env[k];
        else process.env[k] = savedEnv[k];
      }
    },
  };
}

let app: Awaited<ReturnType<typeof boot>>;
let outcomes: Record<string, Outcome> = {};
// Above runStreams' own 15 s timeouts, so a stuck stream fails with its name, not as an unnamed hook timeout.
beforeAll(async () => {
  app = await boot();
  outcomes = { ...(await runContract(app.base, app.ctx)), ...(await runStreams(app.base, app.ctx)) };
}, 60_000);
afterAll(() => app?.dispose());

test('the route table lists every API route of the app', () => {
  const registered = Object.keys(appRoutes(app.deps)).filter((p) => p.startsWith('/api/') && p !== '/api/*');
  expect(ROUTES.map((r) => r.path).sort()).toEqual(registered.sort());
});

test('no case that breaks a body or a guard succeeds', () => {
  const kinds = new Map(cases(app.ctx).map((c) => [c.name, c.kind]));
  const wrong = Object.entries(outcomes).filter(([name, o]) => {
    const kind = kinds.get(name);
    if (name.endsWith('(text/plain)')) return o.status !== 415;
    if (kind === 'violation' || kind === 'body') return o.status < 400;
    // The UI (`/*`) is not guarded: only the API refuses a foreign Host.
    if (name.includes('foreign Origin') || name.includes('Host evil'))
      return !name.startsWith('GET /chat/') && o.status !== 403;
    return false;
  });
  expect(wrong.map(([name, o]) => `${name} → ${o.status}`)).toEqual([]);
});

test('every reply matches the golden record', () => {
  if (process.env.UPDATE_GOLDEN) writeFileSync(GOLDEN, `${JSON.stringify(outcomes, null, 2)}\n`);
  const golden = JSON.parse(readFileSync(GOLDEN, 'utf8')) as Record<string, Outcome>;
  // Same cases in the same order, then the names of the cases whose reply changed, then the diff.
  expect(Object.keys(outcomes)).toEqual(Object.keys(golden));
  const changed = Object.keys(outcomes).filter((name) => !isDeepStrictEqual(outcomes[name], golden[name]));
  const pick = (r: Record<string, Outcome>) => Object.fromEntries(changed.map((name) => [name, r[name]]));
  expect({ changed, replies: pick(outcomes) }).toEqual({ changed: [], replies: pick(golden) });
});
