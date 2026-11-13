#!/usr/bin/env node
// Production entry, bundled to `dist/server/main.js` by `vite build` (`pnpm start`).
import { loadDotEnv, overrideFlag, useEnvProxy } from './env';

loadDotEnv('.env', { override: overrideFlag() });
useEnvProxy();
process.env.NODE_ENV ??= 'production';
// Imported once the `.env` is loaded: modules may read the environment as they load.
const { start } = await import('./index');
await start();
