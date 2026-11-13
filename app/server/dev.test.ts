// The dev loop (`vite dev` in app/): Nitro's worker reloads on each save. A saved route keeps the runtime and
// llama-server (`lib/context.ts`); saved business code undoes the runtime and builds it anew; one SIGINT stops it all.
import { type ChildProcessByStdio, spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Readable } from 'node:stream';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { freePort } from './lib/testing/launch';
import { bootId, isAlive, seedDataDir, startLlama } from './lib/testing/seed';
import { tempDir } from './lib/testing/tempDir';

const APP = resolve(import.meta.dirname, '..');
const dir = tempDir('lw-dev-');
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

beforeAll(async () => {
  ({ profileId } = await seedDataDir(dir.path));
  const port = await freePort();
  const env: Record<string, string | undefined> = {
    ...process.env,
    LLAMA_WEBUI_HOST: '127.0.0.1',
    LLAMA_WEBUI_PORT: String(port),
    LLAMA_WEBUI_DATA_DIR: dir.path,
    LLAMA_WEBUI_TEST_MONITOR: 'stub',
    LLAMA_WEBUI_TEST_OFFLINE: '1',
  };
  for (const k of ['CI', 'TEST', 'NODE_ENV']) delete env[k];
  // Vite itself, not `pnpm dev`: the signal of the last test goes to the process that handles it.
  dev = spawn(process.execPath, [join(APP, 'node_modules/vite/bin/vite.js'), 'dev'], {
    cwd: APP,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  dev.stdout.on('data', (c) => {
    output += c;
  });
  dev.stderr.on('data', (c) => {
    output += c;
  });
  exited = new Promise((done) => dev.once('exit', (code) => done(code)));
  base = `http://127.0.0.1:${port}`;
  await until('vite dev answers /api/health', async () => (await health()).includes('"ok":true'), 60_000);
}, 90_000);

afterAll(async () => {
  if (dev.exitCode === null && dev.signalCode === null) {
    dev.kill('SIGINT');
    await Promise.race([exited, sleep(10_000, null, { ref: false })]);
    if (dev.exitCode === null) dev.kill('SIGKILL');
  }
  dir[Symbol.dispose]();
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
