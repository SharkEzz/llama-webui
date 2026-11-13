import { nitro } from 'nitro/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  define: { LLAMA_WEBUI_VERSION: JSON.stringify('probe-1.2.3') },
  server: { host: '0.0.0.0', port: 7870, strictPort: true },
  plugins: [nitro()],
  nitro: {
    serverDir: './server',
    features: { websocket: true },
    errorHandler: './server/error.ts',
  },
});
