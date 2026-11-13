import { fileURLToPath } from 'node:url';
import { createApi } from './api';
import { cliOptionsOrExit } from './cli';
import { openDb } from './db/open';
import { SettingsRepo } from './db/settings';
import { createDeps } from './deps';
import type { DevHost } from './dev';
import { mount, type WebHandler } from './host';
import { createHostServer } from './hostServer';
import { dbPath } from './paths';
import { nodeWeb, staticWeb, unavailableWeb } from './routes/web';
import { createRuntime, serverView, startMonitor } from './runtime';
import { profilePaths } from './supervisor/args';
import { externalWatcher } from './supervisor/external';
import { APP_VERSION } from './version';

const EXTERNAL_CHECK_MS = 2000;

/**
 * Starts llama-webui for the life of the process: the app is built and listening, then the effects start (orphans,
 * downloads, broadcasts, external server watch), and SIGINT or SIGTERM stops it. Production: `server/main.ts`.
 * Development: `server/dev.ts`, with its HTTP server and Vite's middlewares (`dev`).
 *
 * Each part registers what undoes it on `stack` as it is created; the stack undoes them in reverse order. Until the
 * end of `start()` it belongs to `await using`: a failure on the way (port taken…) undoes what was already built.
 */
export async function start(dev?: DevHost): Promise<void> {
  await using stack = new AsyncDisposableStack();
  // Flags, else env, else defaults (`--help`). Listens locally by default; --host 0.0.0.0 (or LLAMA_WEBUI_HOST) opens
  // it to the local network (no authentication).
  const cli = cliOptionsOrExit();
  const db = stack.use(openDb(dbPath(cli.dataDir)));
  const runtime = createRuntime();
  const { supervisor, logs, benchGate } = runtime;
  stack.defer(() => supervisor.stop());
  // Last resort, synchronous: the process exits without the stack (an uncaught error).
  process.on('exit', () => supervisor.killNow());
  // Development: Vite's middlewares (HMR). Production: the files of `pnpm build`, next to this bundle
  // (`dist/server/main.js` → `dist/web`); without them the API and llama-server control still work.
  const web: WebHandler = dev
    ? nodeWeb(dev.web)
    : await staticWeb(fileURLToPath(new URL('../web/', import.meta.url))).catch((err: unknown) => {
        console.error('[llama-webui] web UI unavailable (run `pnpm build`):', err);
        return unavailableWeb(err);
      });
  const monitor = await startMonitor(runtime, new SettingsRepo(db).get());
  stack.defer(() => monitor.stop());
  const deps = createDeps({ db, runtime, monitor, hostname: cli.host });
  const { hub, settings, conversations, chatRuns, benchRuns, sweeps, benchRunner, profiles, downloads, placement } =
    deps;
  stack.defer(() => placement.dispose());
  // Open WebSockets are closed (1001).
  stack.defer(() => hub.dispose());
  // Undone first: running replies, the benchmark and the download are saved as “stopped”, “interrupted” or resumable
  // while llama-server still runs (a reply would otherwise see the disconnect and end as “error”).
  stack.defer(() => downloads.dispose());
  stack.defer(() => benchRunner.dispose());
  stack.defer(() => chatRuns.dispose());
  const port = await mount({
    server: dev?.http ?? createHostServer(),
    fetch: createApi(deps).fetch,
    hub,
    web,
    hostname: cli.host,
    port: cli.port,
  });

  // A reply left “streaming” when the last process stopped is marked “stopped”.
  conversations.stopOrphans();
  // A benchmark run left “running” is marked “interrupted”, and so is its sweep (Resume button).
  benchRuns.stopOrphans();
  sweeps.stopOrphans();
  monitor.setModelPathResolver((id) => {
    const p = profiles.get(id);
    return p ? profilePaths(p).model : null;
  });
  // Hugging Face downloads: the item left downloading resumes from its `.part`.
  downloads.resume();

  supervisor.subscribe(() => hub.broadcast({ type: 'server-state', payload: serverView(supervisor) }));
  logs.onLines((lines) => hub.broadcast({ type: 'log', payload: lines }));
  monitor.onSnapshot((s) => hub.broadcast({ type: 'snapshot', payload: s }));
  placement.onChange((p) => hub.broadcast({ type: 'placement', payload: p }));

  // External server: detected at startup then watched (leaves the “external” state when it stops).
  const checkExternal = externalWatcher({
    supervisor,
    ports: () => [settings.get().port, supervisor.lastCommand?.port],
    paused: () => benchGate.held || benchRunner.busy,
  });
  void checkExternal();
  stack.use(setInterval(() => void checkExternal(), EXTERNAL_CHECK_MS));

  // Started: the stack now lives until a signal undoes it. A second signal is ignored while the first one stops.
  const live = stack.move();
  let stopping = false;
  const shutdown = async (signal: NodeJS.Signals) => {
    if (stopping) return;
    stopping = true;
    if (supervisor.managedPid !== null) console.log(`[llama-webui] ${signal}: stopping llama-server…`);
    try {
      await live.disposeAsync();
    } catch (err) {
      console.error('[llama-webui] shutdown:', err);
    }
    process.exit(0);
  };
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, (s) => void shutdown(s));

  console.log(`llama-webui on http://${cli.host}:${port}${dev ? ' (dev)' : ` (${APP_VERSION})`}`);
}
