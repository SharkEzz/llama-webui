// One config for the app: the web client (`web/` → `dist/web`), the server (`server/main.ts` → `dist/server/main.js`)
// and its NVML worker (→ `dist/server/nvml-worker.js`). `pnpm build` builds them all (`builder`); `server/dev.ts`
// serves the client and evaluates the server through the ssr environment's module runner. Vitest reads
// `vitest.config.ts`, not this file.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const r = (p: string) => resolve(import.meta.dirname, p);

/**
 * Version shown by `/api/health` and the status bar (`server/version.ts`): the tag, else the short commit hash,
 * `-dirty` with uncommitted changes; without git (a source archive), the version of package.json.
 */
function version(): string {
  try {
    return execFileSync('git', ['describe', '--tags', '--always', '--dirty'], { cwd: r('.'), encoding: 'utf8' }).trim();
  } catch {
    return (JSON.parse(readFileSync(r('package.json'), 'utf8')) as { version: string }).version;
  }
}

export default defineConfig(({ command }) => ({
  root: r('web'),
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': r('web/src') } },
  // Build only: `dev` from source keeps its `dev` version.
  define: command === 'build' ? { LLAMA_WEBUI_VERSION: JSON.stringify(version()) } : {},
  builder: {},
  environments: {
    client: { build: { outDir: r('dist/web'), emptyOutDir: true } },
    ssr: {
      // Dependencies are bundled, except the network-facing ones, `dependencies` of the published package at exact
      // versions (an install from the tarball has no lockfile): a fix in one of them ships with a release.
      resolve: { noExternal: true, external: ['hono', '@hono/node-server', 'ws'] },
      build: {
        ssr: true,
        outDir: r('dist/server'),
        emptyOutDir: true,
        // Node 26 runs it: keep `using` and the rest native.
        target: 'esnext',
        // The licenses of the bundled code ship with it.
        license: { fileName: 'THIRD-PARTY-LICENSES.md' },
        rolldownOptions: {
          input: { main: r('server/main.ts') },
          // One file: `server/index.ts` finds the UI next to it (`dist/server/main.js` → `dist/web`).
          output: { entryFileNames: '[name].js', codeSplitting: false },
        },
      },
    },
    // The NVML worker (`server/collectors/nvml/monitor.ts` starts it next to `main.js`): its own environment, since
    // Rolldown takes a single input when `codeSplitting` is false. Built after `ssr`, which empties the directory;
    // development runs the worker's sources as is (type stripping).
    ...(command === 'build'
      ? {
          nvml: {
            consumer: 'server' as const,
            resolve: { noExternal: true },
            build: {
              ssr: true,
              outDir: r('dist/server'),
              emptyOutDir: false,
              target: 'esnext',
              rolldownOptions: {
                input: { 'nvml-worker': r('server/collectors/nvml/worker.ts') },
                output: { entryFileNames: '[name].js', codeSplitting: false },
              },
            },
          },
        }
      : {}),
  },
}));
