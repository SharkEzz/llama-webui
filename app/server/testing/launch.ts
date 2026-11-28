import { type ChildProcessByStdio, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import type { Readable } from 'node:stream';
import { setTimeout as sleep } from 'node:timers/promises';
import { seedWatchPort } from './seed.ts';

/** The launcher of the production build (`pnpm build`; the server tests' globalSetup builds it, `build.ts`). */
export const LAUNCHER = resolve(import.meta.dirname, '../../.output/llama-webui.mjs');

/**
 * The ports `freePort` draws from: below Linux's ephemeral range (32768–60999), where a `listen(0)` and the outgoing
 * connections of the other tests take theirs. A port from that range, free when `freePort` looked, could be taken by
 * one of them before the program it was meant for listens on it.
 */
const FIRST_PORT = 10_000;
const PORTS_PER_BLOCK = 256;
const BLOCKS = Math.floor((32_768 - FIRST_PORT) / PORTS_PER_BLOCK);
/** This process's block: one per Vitest worker (`VITEST_POOL_ID`, unique among the running workers), else by pid. */
const block = (Number(process.env.VITEST_POOL_ID) || process.pid) % BLOCKS;
/** The next port of the block to try; a random start, a child of a test shares its worker's block. */
let next = Math.floor(Math.random() * PORTS_PER_BLOCK);

/** Whether something already listens on this port of 127.0.0.1. */
const taken = (port: number): Promise<boolean> =>
  new Promise((done) => {
    const s = createServer();
    s.once('error', () => done(true));
    s.listen(port, '127.0.0.1', () => s.close(() => done(false)));
  });

/**
 * A port nothing listens on, on 127.0.0.1, for a program to listen on soon after. Drawn in turn from this process's
 * block of ports (`FIRST_PORT`), so that neither another worker's `freePort` nor a connection gives it out meanwhile;
 * one taken (a service of the machine, a program left by an earlier test) is skipped.
 */
export async function freePort(): Promise<number> {
  for (let tried = 0; tried < PORTS_PER_BLOCK; tried++) {
    const port = FIRST_PORT + block * PORTS_PER_BLOCK + (next % PORTS_PER_BLOCK);
    next += 1;
    if (!(await taken(port))) return port;
  }
  throw new Error(`no free port in the block ${block} of the test ports`);
}

export interface Launched extends AsyncDisposable {
  base: string;
  port: number;
  /** The `port` setting `launch` gave a data folder without a database (null when it had one). */
  watchPort: number | null;
  proc: ChildProcessByStdio<null, Readable, Readable>;
  /** The exit code (null on a signal). */
  exited: Promise<number | null>;
  /** What the server wrote to stdout so far (its log). */
  stdout: () => string;
  /** What the server wrote to stderr so far. */
  stderr: () => string;
}

/** The environment of the test run, as a user's: Vitest's `TEST`, a CI's `CI`, `NODE_ENV` (Vitest sets `test`),
 * `LLAMA_WEBUI_DEV` and ambient `OTEL_*` left out; `extra` on top. */
export function userEnv(extra: Record<string, string> = {}): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const k of ['CI', 'TEST', 'NODE_ENV', 'LLAMA_WEBUI_DEV']) delete env[k];
  for (const k of Object.keys(env)) if (k.startsWith('OTEL_')) delete env[k];
  return { ...env, ...extra };
}

/**
 * The production build in its own process, as a user starts it, on 127.0.0.1, a free port (or `port`) and `dataDir`,
 * from the data dir (no `.env` of the repository around): `--host`, `--port` and `--data-dir`, which win over any
 * `LLAMA_WEBUI_*` variable of the environment. `env` is added to the user's environment (`userEnv`). `launcher` starts
 * another copy of the build. A data folder without a database gets one whose `port` setting is a free port
 * (`seedWatchPort`): the build never looks at 8080. Resolves once `/api/health` answers; disposing sends SIGTERM and
 * awaits the exit.
 */
export async function launch(opts: {
  dataDir: string;
  port?: number;
  env?: Record<string, string>;
  launcher?: string;
}): Promise<Launched> {
  const port = opts.port ?? (await freePort());
  let watchPort: number | null = null;
  if (!existsSync(join(opts.dataDir, 'llama-webui.sqlite'))) {
    watchPort = await freePort();
    await seedWatchPort(opts.dataDir, watchPort);
  }
  const args = ['--host', '127.0.0.1', '--port', String(port), '--data-dir', opts.dataDir];
  const proc = spawn(process.execPath, [opts.launcher ?? LAUNCHER, ...args], {
    cwd: opts.dataDir,
    env: userEnv(opts.env),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  proc.stdout.on('data', (chunk: Buffer) => {
    stdout += String(chunk);
  });
  proc.stderr.on('data', (chunk: Buffer) => {
    stderr += String(chunk);
    process.stderr.write(chunk);
  });
  const exited = new Promise<number | null>((done) => proc.once('exit', (code) => done(code)));
  const base = `http://127.0.0.1:${port}`;
  let up = false;
  const healthAbortController = new AbortController();
  for (let i = 0; i < 100 && !up && proc.exitCode === null; i++) {
    up = (await fetch(`${base}/api/health`, { signal: healthAbortController.signal }).catch(() => null))?.ok === true;
    if (!up) await sleep(100);
  }
  if (!up) {
    proc.kill('SIGKILL');
    throw new Error(`the production build did not answer /api/health:\n${stdout}\n${stderr}`);
  }
  return {
    base,
    port,
    watchPort,
    proc,
    exited,
    stdout: () => stdout,
    stderr: () => stderr,
    async [Symbol.asyncDispose]() {
      if (!healthAbortController.signal.aborted) healthAbortController.abort('SIGTERM');
      if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGTERM');
      await exited;
    },
  };
}
