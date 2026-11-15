import { type ChildProcessByStdio, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import type { Readable } from 'node:stream';
import { setTimeout as sleep } from 'node:timers/promises';
import { seedWatchPort } from './seed.ts';

/** The launcher of the production build (`pnpm build`; the server tests' globalSetup builds it, `build.ts`). */
export const LAUNCHER = resolve(import.meta.dirname, '../../.output/llama-webui.mjs');

export async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const port = (s.address() as { port: number }).port;
  await new Promise((r) => s.close(r));
  return port;
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
  stdout(): string;
  /** What the server wrote to stderr so far. */
  stderr(): string;
}

/** The environment of the test run, as a user's: Vitest's `TEST`, a CI's `CI`, `NODE_ENV` (Vitest sets `test`) and
 * `LLAMA_WEBUI_DEV` left out, users never set them; `extra` on top. */
export function userEnv(extra: Record<string, string> = {}): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env, ...extra };
  for (const k of ['CI', 'TEST', 'NODE_ENV', 'LLAMA_WEBUI_DEV']) delete env[k];
  return env;
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
  proc.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  proc.stderr.on('data', (chunk) => {
    stderr += chunk;
    process.stderr.write(chunk);
  });
  const exited = new Promise<number | null>((done) => proc.once('exit', (code) => done(code)));
  const base = `http://127.0.0.1:${port}`;
  let up = false;
  for (let i = 0; i < 100 && !up && proc.exitCode === null; i++) {
    up = (await fetch(`${base}/api/health`).catch(() => null))?.ok === true;
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
      if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGTERM');
      await exited;
    },
  };
}
