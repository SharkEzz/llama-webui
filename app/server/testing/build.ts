// Vitest globalSetup of the server project: one production build (`app/.output`) per run, for the suites that run it
// (build output, later the contract and the lifecycle). `LLAMA_WEBUI_TEST_BUILD=0` reuses the existing build.
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

export default function setup(): void {
  if (process.env.LLAMA_WEBUI_TEST_BUILD === '0') return;
  const env: Record<string, string | undefined> = { ...process.env };
  // Vitest's `NODE_ENV=test` would give a development React; Vite sets `production` itself.
  delete env.NODE_ENV;
  const r = spawnSync('pnpm', ['run', 'build'], {
    cwd: resolve(import.meta.dirname, '../../..'),
    env,
    encoding: 'utf8',
  });
  if (r.status !== 0) throw new Error(`pnpm build failed (${r.status ?? r.signal}):\n${r.stdout}\n${r.stderr}`);
}
