import { createServer, type Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { createApi } from './api';
import { cliOptionsOrExit } from './cli';
import { openDb } from './db/open';
import { SettingsRepo } from './db/settings';
import { createDeps } from './deps';
import type { DevHost } from './dev';
import { mount, type WebHandler } from './host';
import { dbPath } from './paths';
import { staticWeb, unavailableWeb } from './routes/web';
import { getRuntime, serverView, startMonitor } from './runtime';
import { profilePaths } from './supervisor/args';
import { externalWatcher } from './supervisor/external';
import { APP_VERSION } from './version';

// Flags, else env, else defaults (`--help`). Listens locally by default; --host 0.0.0.0 (or LLAMA_WEBUI_HOST) opens
// it to the local network (no authentication). Re-read on every development reload: same arguments.
const cli = cliOptionsOrExit();
const HOSTNAME = cli.host;
const PORT = cli.port;
const EXTERNAL_CHECK_MS = 2000;

// In development (`server/dev.ts`) this module is re-evaluated on every server-side save, on the same HTTP server.
// The new instance is built and mounted first, then the previous one is released (timers, db, subscriptions): a
// reload that fails to build leaves the old one serving. The supervisor and the logs (runtime) survive the reload.
const g = globalThis as { __llamaWebuiDispose?: () => void; __llamaWebuiDevHost?: DevHost };
const devHost = g.__llamaWebuiDevHost;

const db = openDb(dbPath(cli.dataDir));
const runtime = getRuntime();
const { supervisor, logs } = runtime;
// Development: Vite's middlewares (HMR). Production: the files of `pnpm build`, next to this bundle
// (`dist/server/main.js` → `dist/web`); without them the API and llama-server control still work.
const web: WebHandler = devHost
  ? devHost.web
  : await staticWeb(fileURLToPath(new URL('../web/', import.meta.url))).catch((err: unknown) => {
      console.error('[llama-webui] web UI unavailable (run `pnpm build`):', err);
      return unavailableWeb(err);
    });
const deps = createDeps({
  db,
  runtime,
  monitor: await startMonitor(runtime, new SettingsRepo(db).get()),
  hostname: HOSTNAME,
});
const server: Server = devHost?.http ?? createServer();
const port = await mount({
  server,
  fetch: createApi(deps).fetch,
  hub: deps.hub,
  web,
  hostname: HOSTNAME,
  port: PORT,
  dev: devHost !== undefined,
});
g.__llamaWebuiDispose?.();

const { hub, settings, conversations, chatRuns, benchRuns, sweeps, benchRunner, profiles, downloads, monitor } = deps;
const { placement } = deps;
// A reply left “streaming” after the process was killed is marked interrupted.
conversations.stopOrphans();
const benchGate = runtime.benchGate;
// Cold start: a run left “running” (process killed) is marked interrupted, and so is its sweep (Resume button).
// On reload the gate is still held: the old module has already settled its run and the new one resumes the sweep.
if (!benchGate.held) {
  benchRuns.stopOrphans();
  sweeps.stopOrphans();
}
void benchRunner.resume();
monitor.setModelPathResolver((id) => {
  const p = profiles.get(id);
  return p ? profilePaths(p).model : null;
});
// Hugging Face downloads: recreated on every reload, the new queue resumes the `.part` the old one let go of.
downloads.resume();

const unsubState = supervisor.subscribe(() => hub.broadcast({ type: 'server-state', payload: serverView(supervisor) }));
const unsubLogs = logs.onLines((lines) => hub.broadcast({ type: 'log', payload: lines }));
const unsubSnapshot = monitor.onSnapshot((s) => hub.broadcast({ type: 'snapshot', payload: s }));
const unsubPlacement = placement.onChange((p) => hub.broadcast({ type: 'placement', payload: p }));

// Shutdown: running replies are saved as “interrupted” before the runtime stops llama-server
// (otherwise they would see the disconnect and end as “error”). First in line, ahead of the runtime's handler.
const stopChats = () => {
  chatRuns.dispose();
  benchRunner.dispose({ restart: false });
  downloads.dispose();
};
process.prependListener('SIGINT', stopChats);
process.prependListener('SIGTERM', stopChats);

// External server: detected at startup then watched (leaves the “external” state when it stops).
const checkExternal = externalWatcher({
  supervisor,
  ports: () => [settings.get().port, supervisor.lastCommand?.port],
  paused: () => benchGate.held || benchRunner.busy,
});
void checkExternal();
const externalTimer = setInterval(() => void checkExternal(), EXTERNAL_CHECK_MS);

g.__llamaWebuiDispose = () => {
  clearInterval(externalTimer);
  unsubState();
  unsubLogs();
  unsubSnapshot();
  unsubPlacement();
  placement.dispose();
  monitor.setModelPathResolver(() => null);
  hub.dispose();
  process.off('SIGINT', stopChats);
  process.off('SIGTERM', stopChats);
  chatRuns.dispose();
  // Reload: a one-off run is interrupted, the sweep item is queued again; the gate (runtime) is handed to the
  // new module, or restarts the server if nobody takes it over.
  benchRunner.dispose({ restart: true });
  // The running download stops; its `.part` and its row stay for the new module.
  downloads.dispose();
  db.close();
};

console.log(`llama-webui on http://${HOSTNAME}:${port}${devHost ? ' (dev, HMR)' : ` (${APP_VERSION})`}`);
