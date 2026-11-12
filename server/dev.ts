// `pnpm dev`: one Node process, one port. Vite (middleware mode) serves the UI with HMR, and its ssr environment's
// module runner evaluates the server entry: a server-side save re-evaluates the entry in the same process, so the
// globals of `server/runtime.ts` (llama-server, the logs, the monitor) survive it. Run by plain `node` (erasable TS,
// imports only vite, node:* and `./env.ts`).
import { statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { resolve, sep } from 'node:path';
import {
  createServer as createViteServer,
  type InlineConfig,
  isRunnableDevEnvironment,
  type ViteDevServer,
} from 'vite';
import { loadDotEnv } from './env.ts';

export interface DevOptions {
  /** The server entry, evaluated by the module runner. */
  entry: string;
  /** Directories outside Vite's `root` whose edits reload the entry. */
  watch: string[];
  /** Merged over the defaults (tests pass their own root, without the app's config file). */
  config?: InlineConfig;
}

/** What `server/index.ts` mounts on in development: the long-lived HTTP server and Vite's middlewares. */
export interface DevHost {
  http: Server;
  web: ViteDevServer['middlewares'];
}

/**
 * Starts Vite and evaluates the entry, which mounts the app on `http` (`globalThis.__llamaWebuiDevHost`) and makes it
 * listen. Resolves after the first evaluation.
 */
export async function startDev(o: DevOptions): Promise<{ vite: ViteDevServer; http: Server }> {
  const http = createServer();
  const vite = await createViteServer({
    configFile: resolve(import.meta.dirname, '../vite.config.ts'),
    ...o.config,
    server: { ...o.config?.server, middlewareMode: true, ws: { server: http } },
    appType: 'spa',
  });
  const host: DevHost = { http, web: vite.middlewares };
  (globalThis as { __llamaWebuiDevHost?: DevHost }).__llamaWebuiDevHost = host;

  const ssr = vite.environments.ssr;
  if (!ssr || !isRunnableDevEnvironment(ssr)) throw new Error('the ssr environment of Vite is not runnable');
  const runner = ssr.runner;

  // Track the runner's own imports (its full-reload handler calls `runner.import`): the one in flight and when the
  // last one failed. After a failed reload the runner has cleared its graph, so a fix to the broken file (or the
  // creation of a missing one) no longer maps to an entrypoint and the runner ignores it: re-import the entry then,
  // and only then, once nothing is in flight.
  let inFlight: Promise<unknown> | null = null;
  let failedAt = 0; // 0: the last import succeeded
  const importOnce = runner.import.bind(runner);
  runner.import = ((url: string) => {
    const p = importOnce(url);
    inFlight = p;
    p.then(
      () => {
        failedAt = 0;
      },
      () => {
        failedAt = Date.now();
      },
    ).finally(() => {
      if (inFlight === p) inFlight = null;
    });
    return p;
  }) as typeof runner.import;

  const watched = o.watch.map((d) => resolve(d) + sep);
  let pending = false;
  const recover = (file: string) => {
    if (pending || !watched.some((d) => file.startsWith(d))) return;
    const at = Date.now();
    pending = true;
    // Long enough for the runner's own reload of this change to start (and be tracked as in flight).
    setTimeout(async () => {
      while (inFlight) await inFlight.catch(() => {});
      pending = false;
      // Only from a failure older than this change: a newer one means the runner already tried this content.
      if (!failedAt || failedAt > at) return;
      ssr.moduleGraph.invalidateAll(); // a cached transform may still hold the failed import resolution
      runner.evaluatedModules.clear();
      await runner.import(o.entry).catch((err: unknown) => {
        console.error(`[llama-webui] reload failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    }, 150);
  };
  // Vite watches files outside `root` one by one, and such a watch is lost after two quick atomic replaces (sed -i,
  // an editor's safe write, git checkout). Watching the directories keeps them, and new files emit `add`.
  vite.watcher.add(o.watch.map((d) => resolve(d)));
  vite.watcher.on('change', recover);
  vite.watcher.on('add', recover);
  replayDroppedChanges(vite);

  await runner.import(o.entry);
  return { vite, http };
}

/** Identity of a file's content on disk: an atomic replace changes the inode, an in-place write the mtime or size. */
function version(file: string): string | null {
  try {
    const st = statSync(file, { bigint: true });
    return `${st.ino}:${st.mtimeNs}:${st.size}`;
  } catch {
    return null;
  }
}

/** Past chokidar's 50 ms throttle of `change` events on one file. */
const TRAILING_MS = 60;

/**
 * chokidar drops a `change` that comes within 50 ms of the previous one on the same file, with no trailing event:
 * a second write that close (a format on save) would be missed, and the reload would keep the first content. Each
 * changed file is looked at again once that window has passed, and a change it dropped is replayed (to Vite, which
 * reloads, and to `recover`).
 */
function replayDroppedChanges(vite: ViteDevServer): void {
  vite.watcher.on('change', (file) => {
    const seen = version(file);
    setTimeout(() => {
      if (version(file) !== seen) vite.watcher.emit('change', file);
    }, TRAILING_MS).unref();
  });
}

if (import.meta.main) {
  loadDotEnv();
  const root = resolve(import.meta.dirname, '..');
  await startDev({
    entry: resolve(root, 'server/index.ts'),
    watch: [resolve(root, 'server'), resolve(root, 'packages')],
  });
}
