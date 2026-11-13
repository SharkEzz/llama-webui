// HTTP contract of the app: every case of ./cases.ts over real HTTP against the production build (Nitro's
// `.output/llama-webui.mjs`, built by the server project's globalSetup), compared with golden.json.
// `UPDATE_GOLDEN=1 pnpm exec vitest run app/server/lib/contract/contract.test.ts` rewrites it (`GOLDEN=<file>` writes
// and compares another one). Three replies differ from the Hono server's on purpose: `Host a b` gets a JSON 400, the
// pages are the real `index.html` (`text/html; charset=utf-8`), and h3 sets the SSE streams' own `cache-control`.
import { readFileSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { BenchSpecSchema, SweepSpecSchema } from '@llama-webui/shared';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { ROUTES as FILE_ROUTES } from '../../api.gen';
import { BenchRunsRepo } from '../db/benchRuns';
import { ConversationsRepo } from '../db/conversations';
import { openDb } from '../db/open';
import { ProfilesRepo } from '../db/profiles';
import { SettingsRepo } from '../db/settings';
import { SweepsRepo } from '../db/sweeps';
import { writeGguf } from '../models/gguf.fixture';
import { freePort, launch } from '../testing/launch';
import { tempDir } from '../testing/tempDir';
import { cases, type Outcome, ROUTES, runContract, runStreams } from './cases';

const GOLDEN = resolve(import.meta.dirname, process.env.GOLDEN ?? 'golden.json');
const REPO = resolve(import.meta.dirname, '../../../..');
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

async function boot() {
  const dir = tempDir('lw-contract-');
  const tmp = dir.path;
  const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.HOME = join(tmp, 'home');
  // Outside HOME: Node's homedir() follows this HOME.
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
  const llamaPort = await freePort();
  {
    using db = openDb(join(tmp, 'llama-webui.sqlite'));
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
  }

  // The production build in its own process (`launch()`): the test settings replace the monitor's collectors with a
  // stub and make every Hugging Face request fail as offline.
  const app = await launch({
    dataDir: tmp,
    env: { LLAMA_WEBUI_TEST_MONITOR: 'stub', LLAMA_WEBUI_TEST_OFFLINE: '1' },
  });
  const { base, port } = app;
  return {
    base,
    ctx: { tmp, repo: REPO, home: homedir(), ports: [port, llamaPort], port },
    async dispose() {
      await app[Symbol.asyncDispose]();
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
  const registered = new Set(FILE_ROUTES.map((r) => r.path));
  expect(ROUTES.map((r) => r.path).sort()).toEqual([...registered].sort());
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
