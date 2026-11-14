// The production build as a process: how it starts, refuses to start, and reads its options.
import { type ChildProcessByStdio, spawn } from 'node:child_process';
import { copyFileSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { createServer } from 'node:net';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, expect, test } from 'vitest';
import { freePort, LAUNCHER, launch, userEnv } from './testing/launch.ts';
import { startFakeThrough } from './testing/llama.ts';
import { tempDir } from './testing/tempDir.ts';
import { ofType, openWs } from './testing/ws.ts';

const dir = tempDir('lw-lifecycle-');
afterAll(() => dir[Symbol.dispose]());
let dirs = 0;
const dataDir = () => {
  const path = join(dir.path, `data-${++dirs}`);
  return tempDir('d-', path).path;
};

/** The launcher with `args`, from `cwd`: its stdout and stderr so far, and its exit code. */
function run(args: string[], cwd: string, env: Record<string, string | undefined> = userEnv()) {
  const proc: ChildProcessByStdio<null, Readable, Readable> = spawn(process.execPath, [LAUNCHER, ...args], {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  proc.stdout.on('data', (c) => {
    stdout += c;
  });
  proc.stderr.on('data', (c) => {
    stderr += c;
  });
  const exited = new Promise<number | null>((done) => proc.once('exit', done));
  return { proc, exited, stdout: () => stdout, stderr: () => stderr };
}

/** The exit code within 5 s, else the process is killed and the test fails. */
async function exitCode(app: ReturnType<typeof run>) {
  const code = await Promise.race([app.exited, sleep(5000, 'timeout' as const, { ref: false })]);
  if (code === 'timeout') app.proc.kill('SIGKILL');
  return code;
}

/** Whether `/api/health` answers on `port` before the process exits (5 s at most). */
async function answers(app: ReturnType<typeof run>, port: number) {
  for (let i = 0; i < 50 && app.proc.exitCode === null; i++) {
    const ok = (await fetch(`http://127.0.0.1:${port}/api/health`).catch(() => null))?.ok === true;
    if (ok) return true;
    await sleep(100);
  }
  return false;
}

/** Stops the launcher (SIGTERM) and awaits its exit. */
async function stop(app: ReturnType<typeof run>) {
  if (app.proc.exitCode === null && app.proc.signalCode === null) app.proc.kill('SIGTERM');
  return app.exited;
}

test('a second instance on a taken port exits 1 and names it', async () => {
  await using first = await launch({ dataDir: dataDir() });
  const data = dataDir();
  const second = run(['--host', '127.0.0.1', '--port', String(first.port), '--data-dir', data], data);
  expect(await exitCode(second)).toBe(1);
  expect(second.stderr()).toContain(`cannot listen on 127.0.0.1:${first.port}: the port is already in use`);
  expect(second.stdout()).not.toContain('ready (');
}, 30_000);

test('a port taken by another process exits 1 the same way', async () => {
  const other = createServer();
  const port = await freePort();
  await new Promise<void>((r) => other.listen(port, '127.0.0.1', r));
  try {
    const data = dataDir();
    const app = run(['--host', '127.0.0.1', '--port', String(port), '--data-dir', data], data);
    expect(await exitCode(app)).toBe(1);
    expect(app.stderr()).toBe(`llama-webui: cannot listen on 127.0.0.1:${port}: the port is already in use\n`);
  } finally {
    await new Promise((r) => other.close(r));
  }
}, 30_000);

test('a second instance on the same port and data dir leaves the first one', async () => {
  const data = dataDir();
  await using first = await launch({ dataDir: data });
  const health = async () => (await (await fetch(`${first.base}/api/health`)).json()) as { bootId: string };
  const { bootId } = await health();
  const files = readdirSync(data).sort();
  const second = run(['--host', '127.0.0.1', '--port', String(first.port), '--data-dir', data], data);
  expect(await exitCode(second)).toBe(1);
  expect(second.stdout()).not.toContain('ready (');
  expect((await health()).bootId).toBe(bootId);
  expect(readdirSync(data).sort()).toEqual(files);
}, 30_000);

/**
 * The environment of a user with no `LLAMA_WEBUI_*` variable and a home of its own: should `.env` be missed, the
 * defaults stay inside `home` and the port the test expects goes unanswered (the default port is never asked for).
 */
const bare = (home: string, extra: Record<string, string> = {}) => {
  const env = userEnv();
  for (const k of Object.keys(env)) if (k.startsWith('LLAMA_WEBUI_')) delete env[k];
  return { ...env, HOME: home, XDG_DATA_HOME: home, ...extra };
};

test('a variable of .env sets the port, the environment wins over it', async () => {
  const data = dataDir();
  const fromFile = await freePort();
  writeFileSync(join(data, '.env'), `LLAMA_WEBUI_PORT=${fromFile}\nLLAMA_WEBUI_HOST=127.0.0.1\n`);
  const app = run(['--data-dir', data], data, bare(data));
  try {
    expect(await answers(app, fromFile)).toBe(true);
  } finally {
    expect(await stop(app)).toBe(0);
  }
  const fromEnv = await freePort();
  const env = run(['--data-dir', data], data, bare(data, { LLAMA_WEBUI_PORT: String(fromEnv) }));
  try {
    expect(await answers(env, fromEnv)).toBe(true);
  } finally {
    expect(await stop(env)).toBe(0);
  }
}, 30_000);

test('--env-override lets .env win over the environment', async () => {
  const data = dataDir();
  const fromFile = await freePort();
  writeFileSync(join(data, '.env'), `LLAMA_WEBUI_PORT=${fromFile}\nLLAMA_WEBUI_HOST=127.0.0.1\n`);
  const fromEnv = await freePort();
  const app = run(['--env-override', '--data-dir', data], data, bare(data, { LLAMA_WEBUI_PORT: String(fromEnv) }));
  try {
    expect(await answers(app, fromFile)).toBe(true);
  } finally {
    expect(await stop(app)).toBe(0);
  }
}, 30_000);

test('SIGTERM with the UI open stops in under 2 s', async () => {
  await using app = await launch({ dataDir: dataDir() });
  const client = await openWs(`${app.base.replace('http', 'ws')}/ws`);
  await client.next();
  const t0 = performance.now();
  app.proc.kill('SIGTERM');
  const code = await app.exited;
  expect(performance.now() - t0).toBeLessThan(2000);
  expect(code).toBe(0);
  expect((await client.closed).code).toBe(1001);
}, 30_000);

test('SIGTERM with llama-server running stops it and exits 0 in under 2 s', async () => {
  const data = dataDir();
  {
    await using app = await launch({ dataDir: data });
    const pid = await startFakeThrough(app.base);
    const client = await openWs(`${app.base.replace('http', 'ws')}/ws`);
    await client.next();
    const t0 = performance.now();
    app.proc.kill('SIGTERM');
    const code = await app.exited;
    expect(performance.now() - t0).toBeLessThan(2000);
    expect(code).toBe(0);
    expect((await client.closed).code).toBe(1001);
    expect(alive(pid)).toBe(false);
  }
  // The data folder opens again, the profile in it.
  await using again = await launch({ dataDir: data });
  const profiles = (await (await fetch(`${again.base}/api/profiles`)).json()) as unknown[];
  expect(profiles).toHaveLength(1);
}, 30_000);

test("SIGTERM with the monitor's programs running leaves none of them", async () => {
  const data = dataDir();
  // A fake nvidia-smi, one process as the real one is: each run records its pid, the stream prints one card every
  // 100 ms, a query prints nothing. (A shell loop would fork a `sleep` per line: once killed, its zombie is reaped
  // by this machine's init process only after a second or two, and the spawner waits for the whole group.)
  const smi = join(data, 'nvidia-smi');
  const pids = join(data, 'smi-pids');
  writeFileSync(
    smi,
    `#!${process.execPath}
const { appendFileSync } = require('node:fs');
appendFileSync(${JSON.stringify(pids)}, process.pid + '\\n');
if (!process.argv.includes('-lms')) process.exit(0);
const line = '0, GPU-00000000-0000-0000-0000-000000000001, Fake GPU, 5, 1024, 8192, 40, 50.00, 00000000:01:00.0';
setInterval(() => process.stdout.write(line + '\\n'), 100);
`,
    { mode: 0o755 },
  );
  await using app = await launch({
    dataDir: data,
    // NVML cannot load: the collectors fall back to the nvidia-smi named by the variable.
    env: { LLAMA_WEBUI_NVML_LIB: join(data, 'no-such-libnvidia-ml.so'), LLAMA_WEBUI_NVIDIA_SMI: smi },
  });
  const client = await openWs(`${app.base.replace('http', 'ws')}/ws`);
  const withCard = (message: unknown) =>
    ofType('snapshot')(message) && JSON.stringify(message).includes('nvidia:GPU-00000000-0000-0000-0000-000000000001');
  await client.next(withCard, 10_000);
  const recorded = readFileSync(pids, 'utf8').trim().split('\n').map(Number);
  expect(recorded.length).toBeGreaterThan(0);
  const t0 = performance.now();
  app.proc.kill('SIGTERM');
  const code = await app.exited;
  expect(performance.now() - t0).toBeLessThan(2000);
  expect(code).toBe(0);
  expect((await client.closed).code).toBe(1001);
  expect(recorded.filter(alive)).toEqual([]);
}, 30_000);

test('a data directory of the Nitro server opens untouched', async () => {
  const data = dataDir();
  copyFileSync(join(import.meta.dirname, 'db/fixtures/legacy-v17.sqlite'), join(data, 'llama-webui.sqlite'));
  await using app = await launch({ dataDir: data });
  const settings = (await (await fetch(`${app.base}/api/settings`)).json()) as { port: number; hiddenGpus: string[] };
  expect(settings.port).toBe(8123);
  expect(settings.hiddenGpus).toEqual(['GPU-1']);
}, 30_000);

test('the build never connects to the Effect DevTools', async () => {
  let connections = 0;
  let upgrades = 0;
  const devtools = createHttpServer();
  devtools.on('connection', () => {
    connections += 1;
  });
  devtools.on('upgrade', (_req, socket) => {
    upgrades += 1;
    socket.destroy();
  });
  const port = await freePort();
  await new Promise<void>((listening) => devtools.listen(port, '127.0.0.1', listening));
  try {
    await using _app = await launch({
      dataDir: dataDir(),
      env: { LLAMA_WEBUI_DEVTOOLS_URL: `ws://127.0.0.1:${port}` },
    });
    // Longer than the DevTools client waits for its first connection (1 s): it would have connected by now.
    await sleep(1500);
    expect({ upgrades, connections }).toEqual({ upgrades: 0, connections: 0 });
  } finally {
    devtools.close();
  }
}, 30_000);

/** Whether a process with this pid exists (signal 0). */
function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test('an exit without its finalizers leaves no llama-server', async () => {
  const fixture = join(import.meta.dirname, 'testing/fixtures/exitWithServer.ts');
  const proc = spawn(process.execPath, [fixture], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  proc.stdout.on('data', (c) => {
    stdout += c;
  });
  proc.stderr.on('data', (c) => {
    stderr += c;
  });
  const exited = new Promise<number | null>((done) => proc.once('exit', done));
  const code = await Promise.race([exited, sleep(10_000, 'timeout' as const, { ref: false })]);
  if (code === 'timeout') proc.kill('SIGKILL');
  expect(code, stderr).toBe(1);
  const pid = Number(stdout.trim());
  expect(pid, stdout).toBeGreaterThan(0);
  // The supervisor's `exit` handler sends SIGKILL; the kernel's pdeathsig (setpriv) and the spawner's own `exit`
  // handler would kill it too: this proves the outcome, not which of them did it.
  for (let i = 0; i < 100 && alive(pid); i++) await sleep(20);
  expect(alive(pid)).toBe(false);
}, 30_000);
