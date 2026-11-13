// `pnpm dev`: one Node process, one port. Vite (middleware mode) serves the UI with HMR, and its ssr environment's
// module runner evaluates the server entry once. A save under `server/` or `packages/` restarts the whole process
// (`node --watch-path`, the `dev` script of `package.json`). Run by plain `node` (erasable TS, imports only vite,
// node:*, `./env.ts`, `./hostServer.ts` and types from `./index.ts`).
import { resolve } from 'node:path';
import {
  createServerModuleRunner,
  createServer as createViteServer,
  type InlineConfig,
  type ViteDevServer,
} from 'vite';
import { loadDotEnv, overrideFlag, useEnvProxy } from './env.ts';
import { createHostServer, type HostServer } from './hostServer.ts';
import type { start } from './index.ts';

export interface DevOptions {
  /** The server entry, evaluated once by the module runner: it exports `start()`, as `server/index.ts` does. */
  entry: string;
  /** Merged over the defaults (tests pass their own root, without the app's config file). */
  config?: InlineConfig;
}

/** What `server/index.ts` mounts on in development: the HTTP server Vite's HMR listens on, and Vite's middlewares. */
export interface DevHost {
  http: HostServer;
  web: ViteDevServer['middlewares'];
}

/**
 * Starts Vite, evaluates the entry and calls its `start()` with the dev host: it mounts the app on `http` and makes it
 * listen. Rejects, with Vite closed, when the entry fails.
 */
export async function startDev(o: DevOptions): Promise<{ vite: ViteDevServer; http: HostServer }> {
  const http = createHostServer();
  const vite = await createViteServer({
    configFile: resolve(import.meta.dirname, '../vite.config.ts'),
    ...o.config,
    server: { ...o.config?.server, middlewareMode: true, ws: { server: http } },
    appType: 'spa',
  });
  try {
    const ssr = vite.environments.ssr;
    if (!ssr) throw new Error('Vite has no ssr environment');
    // No server-side HMR: an edit restarts the process instead.
    const runner = createServerModuleRunner(ssr, { hmr: false });
    const entry: { start: typeof start } = await runner.import(o.entry);
    await entry.start({ http, web: vite.middlewares });
  } catch (err) {
    await vite.close();
    throw err;
  }
  return { vite, http };
}

if (import.meta.main) {
  loadDotEnv('.env', { override: overrideFlag() });
  useEnvProxy();
  try {
    await startDev({ entry: resolve(import.meta.dirname, 'index.ts') });
  } catch (err) {
    // `node --watch-path` then waits for the next save under `server/` or `packages/`.
    // The stack only: a Vite error also carries the whole source of the file it failed on.
    console.error(`[llama-webui] start failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    process.exit(1);
  }
}
