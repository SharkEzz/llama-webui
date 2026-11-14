// The web client (`src/`). `vite build` writes it to `.output/public`, then `build/server.ts` bundles the Effect server
// (`server/main.ts`) next to it. `vite dev` serves the UI only until the dev loop comes back (E1, Task 9). Vitest reads
// the root `vitest.config.ts`, not this file.
import { resolve } from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const r = (p: string) => resolve(import.meta.dirname, p);

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': r('src') } },
  build: { outDir: '.output/public', emptyOutDir: true },
  // Same defaults as the server: local only, port 7860.
  server: {
    host: process.env.LLAMA_WEBUI_HOST ?? '127.0.0.1',
    port: Number(process.env.LLAMA_WEBUI_PORT ?? 7860),
    strictPort: true,
  },
});
