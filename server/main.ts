#!/usr/bin/env node
// Production entry, bundled to `dist/server/main.js` by `vite build` (`pnpm start`).
process.env.NODE_ENV ??= 'production';
await import('./index');
