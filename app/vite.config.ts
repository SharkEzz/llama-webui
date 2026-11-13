// The whole app: the web client (`src/`) and the server (`server/`, Nitro's `serverDir`: `routes/`, `middleware/`,
// `plugins/`; the business code in `server/lib/`). `vite dev` serves both on one port (the server in Nitro's dev worker,
// reloaded on each save), `vite build` writes `.output/` (`node_server` preset: `.output/server/index.mjs`, client in
// `.output/public`). Vitest reads the root `vitest.config.ts`, not this file.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { nitro } from 'nitro/vite';
import { build as rolldown } from 'rolldown';
import { defineConfig, type Plugin } from 'vite';
import { OUT, ROUTES_DIR, render, scan } from './scripts/gen-api.ts';
import { loadDotEnv } from './server/lib/env.ts';

const r = (p: string) => resolve(import.meta.dirname, p);

// Development reads `.env` like the production launcher does (the environment wins).
loadDotEnv();

/** Version shown by `/api/health` and the status bar: the tag, else the short hash, else package.json's version. */
function version(): string {
  try {
    return execFileSync('git', ['describe', '--tags', '--always', '--dirty'], { cwd: r('.'), encoding: 'utf8' }).trim();
  } catch {
    return (JSON.parse(readFileSync(r('package.json'), 'utf8')) as { version: string }).version;
  }
}

/** Keeps `server/api.gen.ts` in step with the file routes: at start, then on every change under `routes/api/`. */
function apiTypes(): Plugin {
  const write = () => {
    const text = render(scan());
    let current = '';
    try {
      current = readFileSync(OUT, 'utf8');
    } catch {}
    // Unchanged: not rewritten (the dev worker would reload for nothing).
    if (text !== current) writeFileSync(OUT, text);
  };
  return {
    name: 'llama-webui:api-types',
    buildStart: write,
    configureServer(server) {
      server.watcher.on('all', (_event, file) => {
        if (file.startsWith(ROUTES_DIR)) write();
      });
    },
  };
}

export default defineConfig(({ command }) => ({
  plugins: [apiTypes(), react(), tailwindcss(), nitro()],
  resolve: { alias: { '@': r('src') } },
  // Build only: `dev` from source keeps its `dev` version.
  define: command === 'build' ? { LLAMA_WEBUI_VERSION: JSON.stringify(version()) } : {},
  // Same defaults as the CLI (`server/lib/cli.ts`): local only, port 7860.
  server: {
    host: process.env.LLAMA_WEBUI_HOST ?? '127.0.0.1',
    port: Number(process.env.LLAMA_WEBUI_PORT ?? 7860),
    strictPort: true,
  },
  nitro: {
    serverDir: './server',
    preset: 'node_server',
    features: { websocket: true },
    errorHandler: './server/error.ts',
    // `server/lib/` is business code: not scanned for handlers.
    ignore: ['lib/**'],
    hooks: {
      // Two files of their own next to Nitro's server: the NVML sampler, run in a forked child
      // (`server/lib/collectors/nvml/sampler.ts`, `workerUrl()` resolves it from the chunk `monitor.ts` lands in), and
      // the launcher (`bin/llama-webui.ts`: the CLI, then `server/index.mjs`).
      async compiled(nitro) {
        const { dir, serverDir } = nitro.options.output;
        const files = [
          ['./server/lib/collectors/nvml/worker.ts', join(serverDir, 'nvml-worker.mjs')],
          ['./bin/llama-webui.ts', join(dir, 'llama-webui.mjs')],
        ];
        for (const [input, file] of files)
          await rolldown({ input, platform: 'node', write: true, output: { file, codeSplitting: false } });
      },
    },
  },
}));
