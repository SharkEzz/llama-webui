import { fileURLToPath } from 'node:url';
import mdx from '@mdx-js/rollup';
import { reactRouter } from '@react-router/dev/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  base: '/llama-webui/',
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  plugins: [
    // MDX first: the React Router plugin parses route modules with Babel, so .mdx must already be JS.
    { enforce: 'pre', ...mdx({ providerImportSource: '@mdx-js/react' }) },
    tailwindcss(),
    reactRouter(),
  ],
});
