// The dev loop (`vite dev` in app/): Vite serves the UI and proxies `/api` and `/ws` to the server, which runs from
// source under `node --watch`. On a copy of app/ (`devCopy`) and free ports: the checkout's files stay as they are, and
// a `pnpm dev` the developer runs meanwhile is left alone. One dev server at a time: they share the copy.
import { type ChildProcessByStdio, spawn } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, afterEach, beforeAll, expect, test } from 'vitest';
import { devCopy } from './testing/devCopy.ts';
import { freePort, userEnv } from './testing/launch.ts';
import { startFakeThrough } from './testing/llama.ts';
import { seedWatchPort } from './testing/seed.ts';
import { tempDir } from './testing/tempDir.ts';
import { openWs } from './testing/ws.ts';

const copy = devCopy();
const APP = copy.app;
const dirs = tempDir('lw-dev-');
let runs = 0;

interface Dev {
  readonly proc: ChildProcessByStdio<null, Readable, Readable>;
  readonly exited: Promise<number | null>;
  readonly base: string;
  output(): string;
  /** Each chunk of its output, with the time (`performance.now()`) it arrived. */
  readonly chunks: ReadonlyArray<{ readonly at: number; readonly text: string }>;
}

/** Every dev server a test started, stopped after it if it still runs. */
const started = new Set<Dev>();

/** Polls `check` every 50 ms until it holds, up to `ms`. */
async function until(what: string, check: () => Promise<boolean> | boolean, ms: number, dev?: Dev): Promise<void> {
  const t0 = performance.now();
  while (!(await Promise.resolve(check()).catch(() => false))) {
    if (performance.now() - t0 > ms) throw new Error(`${what}: not within ${ms} ms\n${dev?.output() ?? ''}`);
    await sleep(50);
  }
}

/** Whether `pid` runs (a zombie, exited and not reaped yet, does not). */
function isAlive(pid: number): boolean {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    // `pid (comm) state …`: the state follows the last parenthesis.
    return stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3) !== 'Z';
  } catch {
    return false;
  }
}

/** `pid` and every process under it: Vite, `node --watch`, the server it runs. */
function tree(pid: number): number[] {
  let children: number[] = [];
  try {
    children = readFileSync(`/proc/${pid}/task/${pid}/children`, 'utf8')
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map(Number);
  } catch {
    // Gone already.
  }
  return [pid, ...children.flatMap(tree)];
}

const health = async (base: string) => (await fetch(`${base}/api/health`)).json() as Promise<{ bootId: string }>;
const bootId = async (base: string) => (await health(base)).bootId;
const serverKind = async (base: string) =>
  ((await (await fetch(`${base}/api/server/state`)).json()) as { state: { kind: string } }).state.kind;

/**
 * Starts `vite dev` in the copy on a free port (or the `.env`'s, with `LLAMA_WEBUI_PORT: undefined`), with `env` over
 * the user's environment: a fresh data dir, `XDG_DATA_HOME` in it (the developer's database is never touched), and the
 * DevTools address on a closed port. Resolves once `/api/health` answers through Vite's port.
 */
async function startDev(env: Record<string, string | undefined> = {}, port?: number): Promise<Dev> {
  const data = join(dirs.path, `run-${++runs}`);
  const full: Record<string, string | undefined> = userEnv({
    LLAMA_WEBUI_HOST: '127.0.0.1',
    LLAMA_WEBUI_PORT: String(await freePort()),
    LLAMA_WEBUI_DATA_DIR: join(data, 'data'),
    XDG_DATA_HOME: join(data, 'xdg'),
    LLAMA_WEBUI_DEVTOOLS_URL: `ws://127.0.0.1:${await freePort()}`,
  });
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete full[k];
    else full[k] = v;
  }
  // The watch of a server started by hand looks at the `port` setting: never at 8080, the user's own llama-server's.
  const dataDir = full.LLAMA_WEBUI_DATA_DIR;
  if (dataDir !== undefined) await seedWatchPort(dataDir, await freePort());
  let output = '';
  const chunks: Array<{ at: number; text: string }> = [];
  // Vite itself, not `pnpm dev`: a signal goes to the process that handles it.
  const proc = spawn(process.execPath, [join(APP, 'node_modules/vite/bin/vite.js'), 'dev'], {
    cwd: APP,
    env: full,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const collect = (c: Buffer) => {
    output += c;
    chunks.push({ at: performance.now(), text: String(c) });
  };
  proc.stdout.on('data', collect);
  proc.stderr.on('data', collect);
  const exited = new Promise<number | null>((done) => proc.once('exit', (code) => done(code)));
  // The port Vite listens on: the environment's, else the `.env`'s, given as `port`.
  const listens = port ?? Number(full.LLAMA_WEBUI_PORT);
  const dev: Dev = { proc, exited, base: `http://127.0.0.1:${listens}`, output: () => output, chunks };
  started.add(dev);
  await until('vite dev answers /api/health', async () => (await health(dev.base)).bootId !== undefined, 60_000, dev);
  return dev;
}

/** Stops `dev` with SIGINT and waits for every process of its tree to be gone; the time it took. */
async function stopped(dev: Dev, pids: number[], ms: number): Promise<number> {
  const t0 = performance.now();
  await until('vite dev and the server are gone', () => pids.every((pid) => !isAlive(pid)), ms, dev);
  return performance.now() - t0;
}

/** Runs `body` with `file` of the copy edited (a comment appended), then restores it. */
async function edited(file: string, body: () => Promise<void>): Promise<void> {
  const path = join(APP, file);
  const original = readFileSync(path, 'utf8');
  writeFileSync(path, `${original}// dev.test.ts\n`);
  try {
    await body();
  } finally {
    // Not within a few ms of the edit: a watcher may drop a second change that close.
    await sleep(200);
    writeFileSync(path, original);
  }
}

/** Stops every dev server still running (SIGINT, then SIGKILL to what is left of its tree). */
async function stopAll(): Promise<void> {
  for (const dev of started) {
    if (dev.proc.exitCode === null && dev.proc.signalCode === null) {
      const pids = tree(dev.proc.pid ?? 0);
      dev.proc.kill('SIGINT');
      await Promise.race([dev.exited, sleep(10_000, null, { ref: false })]);
      for (const pid of pids) if (isAlive(pid)) process.kill(pid, 'SIGKILL');
    }
  }
  started.clear();
}

afterEach(async () => {
  await stopAll();
  rmSync(join(APP, '.env'), { force: true });
});

afterAll(async () => {
  if (shared !== undefined) started.add(shared);
  await stopAll();
  copy[Symbol.dispose]();
  dirs[Symbol.dispose]();
});

let shared: Dev | undefined;
beforeAll(async () => {
  shared = await startDev();
  started.delete(shared);
}, 90_000);

/** The dev server the first tests share, started once. */
function sharedDev(): Dev {
  if (shared === undefined) throw new Error('the shared dev server did not start');
  return shared;
}

test('saving a server file restarts the server', async () => {
  const dev = sharedDev();
  const pid = await startFakeThrough(dev.base);
  const before = await bootId(dev.base);
  let booted = '';
  await edited('server/health/http.ts', () =>
    until(
      'a new boot',
      async () => {
        booted = await bootId(dev.base);
        return booted !== before;
      },
      30_000,
      dev,
    ),
  );
  // The old server stopped its llama-server; the new one runs none.
  expect(isAlive(pid)).toBe(false);
  expect(await serverKind(dev.base)).toBe('idle');
  // Restoring the file is a second save, a second restart: settled before the next test.
  await until('the boot after the restore', async () => (await bootId(dev.base)) !== booted, 30_000, dev);
}, 90_000);

test('saving a web file keeps the server', async () => {
  const dev = sharedDev();
  const before = await bootId(dev.base);
  await edited('src/main.tsx', async () => {
    // Longer than a restart takes: a restart would show by now.
    await sleep(3000);
    expect(await bootId(dev.base)).toBe(before);
  });
  await sleep(3000);
  expect(await bootId(dev.base)).toBe(before);
}, 30_000);

test('in dev, without Effect DevTools, a restart does not wait for them', async () => {
  const dev = sharedDev();
  // `startDev` points the DevTools address at a closed port.
  expect(dev.output()).toMatch(/no Effect DevTools at ws:\/\/127\.0\.0\.1:\d+: start them, then save a server file/);
  const before = await bootId(dev.base);
  const from = dev.chunks.length;
  let booted = '';
  let bootedAt = 0;
  await edited('server/health/http.ts', () =>
    until(
      'a new boot',
      async () => {
        booted = await bootId(dev.base);
        bootedAt = performance.now();
        return booted !== before;
      },
      30_000,
      dev,
    ),
  );
  // From the line `node --watch` prints when it restarts the server to the first answer of the new one.
  const restarting = dev.chunks.slice(from).find((chunk) => chunk.text.includes('Restarting'));
  if (restarting === undefined) throw new Error(`no Restarting line\n${dev.output()}`);
  expect(bootedAt - restarting.at).toBeLessThan(1000);
  await until('the boot after the restore', async () => (await bootId(dev.base)) !== booted, 30_000, dev);
}, 90_000);

test('one SIGINT stops vite dev and the server', async () => {
  const dev = sharedDev();
  started.add(dev);
  const llama = await startFakeThrough(dev.base);
  const pids = tree(dev.proc.pid ?? 0);
  // Vite, `node --watch`, the server and its llama-server.
  expect(pids.length).toBeGreaterThanOrEqual(4);
  expect(pids).toContain(llama);
  dev.proc.kill('SIGINT');
  expect(await stopped(dev, pids, 5000)).toBeLessThan(5000);
}, 30_000);

test('one SIGINT with a page open (/ws) stops at once', async () => {
  const dev = await startDev();
  const pids = tree(dev.proc.pid ?? 0);
  const client = await openWs(`${dev.base.replace('http', 'ws')}/ws`);
  await client.next();
  const t0 = performance.now();
  dev.proc.kill('SIGINT');
  const closed = await Promise.race([client.closed, sleep(2000, null, { ref: false })]);
  // The server's own 1001, through Vite: it stopped (a server killed instead would leave the page a 1006).
  expect(closed?.code).toBe(1001);
  await stopped(dev, pids, 2000);
  expect(performance.now() - t0).toBeLessThan(2000);
}, 90_000);

test('two quick SIGINTs still stop the server', async () => {
  const dev = await startDev();
  const llama = await startFakeThrough(dev.base);
  const pids = tree(dev.proc.pid ?? 0);
  // No llama-server left either.
  expect(pids).toContain(llama);
  dev.proc.kill('SIGINT');
  await sleep(20);
  dev.proc.kill('SIGINT');
  await stopped(dev, pids, 5000);
}, 90_000);

test('a SIGHUP (the terminal closed) stops vite dev and the server', async () => {
  const dev = await startDev();
  const pids = tree(dev.proc.pid ?? 0);
  dev.proc.kill('SIGHUP');
  await stopped(dev, pids, 5000);
  expect(await dev.exited).toBe(129);
}, 90_000);

test('dev reads .env, the environment wins over it', async () => {
  const fromFile = await freePort();
  writeFileSync(join(APP, '.env'), `LLAMA_WEBUI_PORT=${fromFile}\n`);
  const fromDotEnv = await startDev({ LLAMA_WEBUI_PORT: undefined }, fromFile);
  expect((await health(fromDotEnv.base)).bootId).toBeTypeOf('string');
  const pids = tree(fromDotEnv.proc.pid ?? 0);
  fromDotEnv.proc.kill('SIGINT');
  await stopped(fromDotEnv, pids, 5000);

  const fromEnv = await freePort();
  const dev = await startDev({ LLAMA_WEBUI_PORT: String(fromEnv) });
  expect(dev.base).toBe(`http://127.0.0.1:${fromEnv}`);
  await expect(fetch(`http://127.0.0.1:${fromFile}/api/health`)).rejects.toThrow();
}, 90_000);

test('in dev the server connects to the Effect DevTools address', async () => {
  let upgrades = 0;
  const devtools = createServer();
  devtools.on('upgrade', (_req, socket) => {
    upgrades += 1;
    socket.destroy();
  });
  const port = await freePort();
  await new Promise<void>((listening) => devtools.listen(port, '127.0.0.1', listening));
  try {
    const dev = await startDev({ LLAMA_WEBUI_DEVTOOLS_URL: `ws://127.0.0.1:${port}` });
    await until('an upgrade request to the DevTools address', () => upgrades > 0, 5000, dev);
    expect(dev.output()).toContain(`Effect DevTools connected (ws://127.0.0.1:${port})`);
  } finally {
    devtools.close();
  }
}, 90_000);
