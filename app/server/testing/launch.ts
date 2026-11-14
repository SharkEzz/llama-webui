import { type ChildProcessByStdio, spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import type { Readable } from 'node:stream';
import { setTimeout as sleep } from 'node:timers/promises';

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
  proc: ChildProcessByStdio<null, Readable, Readable>;
  /** The exit code (null on a signal). */
  exited: Promise<number | null>;
  /** What the server wrote to stdout so far (its log). */
  stdout(): string;
  /** What the server wrote to stderr so far. */
  stderr(): string;
}

/**
 * The production build in its own process, as a user starts it, on 127.0.0.1, a free port (or `port`) and `dataDir`,
 * from the data dir (no `.env` of the repository around). The address and the data dir go through `LLAMA_WEBUI_HOST`,
 * `LLAMA_WEBUI_PORT` and `LLAMA_WEBUI_DATA_DIR` until the launcher reads flags (E1, Task 4). Vitest's `TEST`, a CI's
 * `CI` and `NODE_ENV` (Vitest sets `test`) are left out: users never set them. `launcher` starts another copy of the
 * build. Resolves once `/api/health` answers; disposing sends SIGTERM and awaits the exit.
 */
export async function launch(opts: {
  dataDir: string;
  port?: number;
  env?: Record<string, string>;
  launcher?: string;
}): Promise<Launched> {
  const port = opts.port ?? (await freePort());
  const env: Record<string, string | undefined> = {
    ...process.env,
    LLAMA_WEBUI_HOST: '127.0.0.1',
    LLAMA_WEBUI_PORT: String(port),
    LLAMA_WEBUI_DATA_DIR: opts.dataDir,
    ...opts.env,
  };
  for (const k of ['CI', 'TEST', 'NODE_ENV', 'LLAMA_WEBUI_DEV']) delete env[k];
  const proc = spawn(process.execPath, [opts.launcher ?? LAUNCHER], {
    cwd: opts.dataDir,
    env,
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
