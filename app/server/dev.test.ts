// The dev loop (`vite dev` in app/): Nitro's worker reloads on each save. A saved route keeps the runtime and
// llama-server (`lib/context.ts`); saved business code undoes the runtime and builds it anew; one SIGINT stops it all.
// Run in order, one dev server at a time: two in app/ share Nitro's and Vite's caches.
import { type ChildProcessByStdio, spawn } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Readable } from 'node:stream';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { freePort } from './lib/testing/launch';
import { bootId, isAlive, seedDataDir, startLlama } from './lib/testing/seed';
import { tempDir } from './lib/testing/tempDir';

const APP = resolve(import.meta.dirname, '..');
const dir = tempDir('lw-dev-');
const envDirs = tempDir('lw-dev-env-');
let dev: ChildProcessByStdio<null, Readable, Readable>;
let exited: Promise<number | null>;
let base = '';
let profileId = 0;
let output = '';

/** Polls `check` every 50 ms until it holds, up to `ms`. */
async function until(what: string, check: () => Promise<boolean>, ms = 30_000): Promise<void> {
  const t0 = performance.now();
  while (!(await check().catch(() => false))) {
    if (performance.now() - t0 > ms) throw new Error(`${what}: not within ${ms} ms\n${output}`);
    await sleep(50);
  }
}

/** Runs `body` with `file` edited (`edit` of its text), then restores it. */
async function edited(file: string, edit: (text: string) => string, body: () => Promise<void>): Promise<void> {
  const original = readFileSync(file, 'utf8');
  writeFileSync(file, edit(original));
  try {
    await body();
  } finally {
    // Not within a few ms of the edit: Vite's file watcher (chokidar) drops a second change that close.
    await sleep(200);
    writeFileSync(file, original);
  }
}

const health = () => fetch(`${base}/api/health`).then((r) => r.text());

/** The pid of the managed llama-server, if one runs. */
async function serverPid(): Promise<number | null> {
  const { state } = (await (await fetch(`${base}/api/server/state`)).json()) as { state: { pid?: number } };
  return state.pid ?? null;
}

/** Starts `vite dev` in app/ on a free port with `env` over the test's environment (`CI`, `TEST`, `NODE_ENV` left out). */
async function startDev(env: Record<string, string | undefined>): Promise<void> {
  const port = await freePort();
  const full: Record<string, string | undefined> = {
    ...process.env,
    LLAMA_WEBUI_HOST: '127.0.0.1',
    LLAMA_WEBUI_PORT: String(port),
    LLAMA_WEBUI_TEST_MONITOR: 'stub',
    LLAMA_WEBUI_TEST_OFFLINE: '1',
    ...env,
  };
  for (const k of ['CI', 'TEST', 'NODE_ENV']) delete full[k];
  for (const [k, v] of Object.entries(full)) if (v === undefined) delete full[k];
  output = '';
  // Vite itself, not `pnpm dev`: a signal goes to the process that handles it.
  const proc = spawn(process.execPath, [join(APP, 'node_modules/vite/bin/vite.js'), 'dev'], {
    cwd: APP,
    env: full,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout.on('data', (c) => {
    output += c;
  });
  proc.stderr.on('data', (c) => {
    output += c;
  });
  dev = proc;
  exited = new Promise((done) => proc.once('exit', (code) => done(code)));
  base = `http://127.0.0.1:${port}`;
  await until('vite dev answers /api/health', async () => (await health()).includes('"ok":true'), 60_000);
}

beforeAll(async () => {
  ({ profileId } = await seedDataDir(dir.path));
  await startDev({ LLAMA_WEBUI_DATA_DIR: dir.path });
}, 90_000);

afterAll(async () => {
  if (dev.exitCode === null && dev.signalCode === null) {
    dev.kill('SIGINT');
    await Promise.race([exited, sleep(10_000, null, { ref: false })]);
    if (dev.exitCode === null) dev.kill('SIGKILL');
  }
  dir[Symbol.dispose]();
  envDirs[Symbol.dispose]();
});

test('saving a route file keeps llama-server and the boot', async () => {
  const before = { pid: await startLlama(base, profileId), bootId: await bootId(base) };
  await edited(
    join(APP, 'server/routes/api/health.get.ts'),
    (t) => t.replace('reply({ ok: true,', "reply({ ok: true, marker: 'dev-test',"),
    () => until('the edited route answers', async () => (await health()).includes('dev-test')),
  );
  await until('the restored route answers', async () => !(await health()).includes('dev-test'));
  const after = { pid: (await serverPid()) ?? 0, bootId: await bootId(base) };
  expect(after.bootId).toBe(before.bootId);
  expect(after.pid).toBe(before.pid);
  expect(isAlive(before.pid)).toBe(true);
}, 60_000);

test('saving business code rebuilds the runtime and stops the old llama-server', async () => {
  const before = { pid: (await serverPid()) ?? (await startLlama(base, profileId)), bootId: await bootId(base) };
  // A comment only: the module changes, its value does not (`version.test.ts` may run meanwhile).
  let booted = '';
  await edited(
    join(APP, 'server/lib/version.ts'),
    (t) => `${t}// dev.test.ts\n`,
    () =>
      until('a new boot', async () => {
        booted = await bootId(base);
        return booted !== before.bootId;
      }),
  );
  await until('the old llama-server exits', async () => !isAlive(before.pid), 10_000);
  // Restoring the file is a second save, which boots again (within ~60 ms): settled before the next test.
  await until('the boot after the restore', async () => (await bootId(base)) !== booted);
}, 90_000);

test('one SIGINT stops vite dev and llama-server', async () => {
  const pid = await startLlama(base, profileId);
  dev.kill('SIGINT');
  // Nitro's dev server closes Vite (our `close` hook stops llama-server), then exits 130, as a shell does on Ctrl+C.
  expect(await Promise.race([exited, sleep(10_000, 'timeout', { ref: false })])).toBe(130);
  expect(isAlive(pid)).toBe(false);
}, 30_000);

test('two quick SIGINTs (a double Ctrl+C) still stop llama-server', async () => {
  await startDev({ LLAMA_WEBUI_DATA_DIR: dir.path });
  const pid = await startLlama(base, profileId);
  try {
    dev.kill('SIGINT');
    await sleep(20);
    dev.kill('SIGINT');
    await Promise.race([exited, sleep(10_000, null, { ref: false })]);
    await until('llama-server exits', async () => !isAlive(pid), 5000);
  } finally {
    if (isAlive(pid)) process.kill(pid, 'SIGKILL');
  }
}, 90_000);

test("dev reads .env.local too: Nitro's Vite plugin loads it (the production launcher reads .env only)", async () => {
  // No LLAMA_WEBUI_DATA_DIR in the environment: without .env.local the data dir would be $XDG_DATA_HOME/llama-webui.
  // nitro/vite hard-codes `.env`, `.env.local`, `.env.<mode>`, `.env.<mode>.local`; no option changes the list.
  const xdg = join(envDirs.path, 'xdg');
  const fromEnvLocal = join(envDirs.path, 'from-env-local');
  const file = join(APP, '.env.local');
  if (existsSync(file)) throw new Error(`${file} exists: not overwritten`);
  writeFileSync(file, `LLAMA_WEBUI_DATA_DIR=${fromEnvLocal}\n`);
  try {
    await startDev({ LLAMA_WEBUI_DATA_DIR: undefined, XDG_DATA_HOME: xdg });
    expect(existsSync(join(fromEnvLocal, 'llama-webui.sqlite'))).toBe(true);
    expect(existsSync(xdg)).toBe(false);
  } finally {
    rmSync(file, { force: true });
    dev.kill('SIGINT');
    await Promise.race([exited, sleep(10_000, null, { ref: false })]);
  }
}, 90_000);
