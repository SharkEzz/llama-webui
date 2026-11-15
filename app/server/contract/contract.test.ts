// HTTP contract of the app: every case of ./cases.ts over real HTTP against the production build
// (`.output/llama-webui.mjs`, built by the server project's globalSetup), compared with golden.json.
// `UPDATE_GOLDEN=1 pnpm exec vitest run app/server/contract/contract.test.ts` rewrites it (`GOLDEN=<file>` writes and
// compares another one).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { writeGguf } from '../testing/gguf.ts';
import { freePort, type Launched, launch } from '../testing/launch.ts';
import { type TempDir, tempDir } from '../testing/tempDir.ts';
import {
  assetOf,
  cases,
  covers,
  endpoints,
  type Fixtures,
  type NormalizeCtx,
  type Outcome,
  runContract,
  runStreams,
} from './cases.ts';

const GOLDEN = resolve(import.meta.dirname, process.env.GOLDEN ?? 'golden.json');
const REPO = resolve(import.meta.dirname, '../../..');

let dir: TempDir;
let app: Launched;
let ctx: NormalizeCtx;
let fixtures: Fixtures & { livePort: number };
let outcomes: Record<string, Outcome> = {};

beforeAll(async () => {
  dir = tempDir('lw-contract-');
  const home = join(dir.path, 'home');
  mkdirSync(join(home, 'models'), { recursive: true });
  // The models folder (the default `~/models`) holds one small model.
  const model = join(home, 'models', 'm.gguf');
  await writeGguf(
    model,
    {
      'general.architecture': { type: 'string', value: 'llama' },
      'general.name': { type: 'string', value: 'Tiny' },
      'general.file_type': { type: 'u32', value: 15 },
      'llama.block_count': { type: 'u32', value: 1 },
      'llama.embedding_length': { type: 'u32', value: 64 },
      'llama.attention.head_count': { type: 'u32', value: 4 },
      'llama.context_length': { type: 'u32', value: 4096 },
    },
    [
      { name: 'token_embd.weight', shape: [64, 100], bytes: 6400 },
      { name: 'blk.0.attn_q.weight', shape: [64, 64], bytes: 4096 },
      { name: 'output.weight', shape: [64, 100], bytes: 6400 },
    ],
  );
  // A home and XDG folders of the run's own: nothing of the user's shows in a reply. The stub monitor: no program
  // runs, no snapshot comes, the history stays empty. Offline: no request leaves the machine (a Hub call fails with
  // `fetch failed`), no token of the user's (variable or file), the default endpoint whatever the user's is.
  app = await launch({
    dataDir: dir.path,
    env: {
      HOME: home,
      XDG_DATA_HOME: join(home, 'data'),
      XDG_CONFIG_HOME: join(home, 'config'),
      LLAMA_WEBUI_TEST_MONITOR: 'stub',
      LLAMA_WEBUI_TEST_OFFLINE: '1',
      HF_TOKEN: '',
      HUGGING_FACE_HUB_TOKEN: '',
      HF_HOME: join(home, 'hf'),
      HF_TOKEN_PATH: join(home, 'hf', 'token'),
      HF_ENDPOINT: 'https://huggingface.co',
    },
  });
  // The port of the live profile (the fake llama-server of `runStreams`): free, never llama-server's default.
  const livePort = await freePort();
  const ports = app.watchPort === null ? [app.port] : [app.port, app.watchPort];
  ctx = { tmp: dir.path, repo: REPO, home, ports: [...ports, livePort] };
  fixtures = {
    fake: join(REPO, 'testdata/fake/fake-llama-server'),
    missing: join(dir.path, 'no-such-llama-server'),
    model,
    noModel: join(dir.path, 'no-such-model.gguf'),
    livePort,
  };
  outcomes = { ...(await runContract(app.base, ctx, fixtures)), ...(await runStreams(app.base, ctx, fixtures)) };
}, 60_000);
afterAll(async () => {
  await app?.[Symbol.asyncDispose]();
  dir?.[Symbol.dispose]();
});

test('the cases cover every endpoint of the API definition', async () => {
  const all = cases({ base: app.base, asset: await assetOf(app.base), ...fixtures });
  expect(endpoints().filter((endpoint) => !all.some((c) => covers(endpoint, c.req)))).toEqual([]);
});

test('no case that breaks a payload or the guard, or that the domain refuses, succeeds', async () => {
  const kinds = new Map(
    cases({ base: app.base, asset: await assetOf(app.base), ...fixtures }).map((c) => [c.name, c.kind]),
  );
  const breaking = new Set(['violation', 'refusal', 'body', 'guard']);
  const wrong = Object.entries(outcomes).filter(([name, o]) => breaking.has(kinds.get(name) ?? '') && o.status < 400);
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
