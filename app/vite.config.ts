// The web client (`src/`). `vite build` writes it to `.output/public`, then `build/server.ts` bundles the Effect server
// (`server/main.ts`) next to it. `vite dev` is the whole dev loop: the UI with HMR, and the server from source under
// `node --watch` behind `/api` and `/ws` (`build/devServer.ts`). Vitest reads the root `vitest.config.ts`, not this file.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { devServer } from './build/devServer.ts';
import { applyDotEnv } from './server/config/DotEnv.ts';

const r = (p: string) => resolve(import.meta.dirname, p);

/** `.env` of the current folder, as the production entry reads it: the environment wins (unless it asks otherwise). */
function readDotEnv(): string | undefined {
  try {
    return readFileSync('.env', 'utf8');
  } catch {
    return undefined;
  }
}
const dotEnv = readDotEnv();
// Before the address is read below; the server child inherits the result.
if (dotEnv !== undefined) applyDotEnv(process.env, dotEnv);

export default defineConfig({
  plugins: [react(), tailwindcss(), devServer()],
  resolve: { alias: { '@': r('src') } },
  build: { outDir: '.output/public', emptyOutDir: true },
  // Same defaults as the server: local only, port 7860.
  server: {
    host: process.env.LLAMA_WEBUI_HOST ?? '127.0.0.1',
    port: Number(process.env.LLAMA_WEBUI_PORT ?? 7860),
    strictPort: true,
  },
});
