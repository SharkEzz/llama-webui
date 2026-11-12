#!/usr/bin/env node
// Production entry, bundled to `dist/server/main.js` by `vite build` (`pnpm start`).
import { loadDotEnv, overrideFlag } from './env';

loadDotEnv('.env', { override: overrideFlag() });
process.env.NODE_ENV ??= 'production';
await import('./index');
