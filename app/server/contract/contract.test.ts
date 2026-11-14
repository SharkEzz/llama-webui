// HTTP contract of the app: every case of ./cases.ts over real HTTP against the production build
// (`.output/llama-webui.mjs`, built by the server project's globalSetup), compared with golden.json.
// `UPDATE_GOLDEN=1 pnpm exec vitest run app/server/contract/contract.test.ts` rewrites it (`GOLDEN=<file>` writes and
// compares another one).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { type Launched, launch } from '../testing/launch.ts';
import { type TempDir, tempDir } from '../testing/tempDir.ts';
import { assetOf, cases, covers, endpoints, type NormalizeCtx, type Outcome, runContract } from './cases.ts';

const GOLDEN = resolve(import.meta.dirname, process.env.GOLDEN ?? 'golden.json');
const REPO = resolve(import.meta.dirname, '../../..');

let dir: TempDir;
let app: Launched;
let ctx: NormalizeCtx;
let outcomes: Record<string, Outcome> = {};

beforeAll(async () => {
  dir = tempDir('lw-contract-');
  const home = join(dir.path, 'home');
  mkdirSync(home);
  // A home and XDG folders of the run's own: nothing of the user's shows in a reply.
  app = await launch({
    dataDir: dir.path,
    env: { HOME: home, XDG_DATA_HOME: join(home, 'data'), XDG_CONFIG_HOME: join(home, 'config') },
  });
  ctx = { tmp: dir.path, repo: REPO, home, ports: [app.port] };
  outcomes = await runContract(app.base, ctx);
}, 60_000);
afterAll(async () => {
  await app?.[Symbol.asyncDispose]();
  dir?.[Symbol.dispose]();
});

test('the cases cover every endpoint of the API definition', async () => {
  const all = cases({ asset: await assetOf(app.base) });
  expect(endpoints().filter((endpoint) => !all.some((c) => covers(endpoint, c.req)))).toEqual([]);
});

test('no case that breaks a payload or the guard, or that the domain refuses, succeeds', async () => {
  const kinds = new Map(cases({ asset: await assetOf(app.base) }).map((c) => [c.name, c.kind]));
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
