import index from '../web/index.html';
import { createApp } from './app';
import { RunExecutor } from './bench/execute';
import { readHardware } from './bench/hardware';
import { BenchRunner } from './bench/runner';
import { ChatRuns } from './chat/runs';
import { cliOptionsOrExit } from './cli';
import { BenchRunsRepo } from './db/benchRuns';
import { ConversationsRepo } from './db/conversations';
import { DownloadsRepo } from './db/downloads';
import { openDb } from './db/open';
import { ProfilesRepo } from './db/profiles';
import { SettingsRepo } from './db/settings';
import { SweepsRepo } from './db/sweeps';
import { HfClient } from './hf/client';
import { DownloadQueue } from './hf/downloader';
import { PlacementTracker } from './monitor/placement';
import { dbPath } from './paths';
import { buildWebRoutes, unavailableWebRoutes } from './routes/web';
import { activeProfileId, getRuntime, serverView, startMonitor } from './runtime';
import { binaryPath, buildCommand, profilePaths } from './supervisor/args';
import { externalWatcher } from './supervisor/external';
import { APP_VERSION } from './version';
import { WsHub } from './ws/hub';

// Flags, else env, else defaults (`--help`). Listens locally by default; --host 0.0.0.0 (or LLAMA_WEBUI_HOST) opens
// it to the local network (no authentication). Re-read on every `bun --hot` reload: same arguments.
const cli = cliOptionsOrExit();
const HOSTNAME = cli.host;
const PORT = cli.port;
const EXTERNAL_CHECK_MS = 2000;

// Under `bun --hot`, this module is re-evaluated: release the previous instance (timers, db, subscriptions).
// The supervisor and the logs (runtime) survive the reload.
const g = globalThis as { __llamaWebuiDispose?: () => void };
g.__llamaWebuiDispose?.();

const db = openDb(dbPath(cli.dataDir));
const runtime = getRuntime();
const hub = new WsHub(runtime.bootId);
const settings = new SettingsRepo(db);
const profiles = new ProfilesRepo(db);
const conversations = new ConversationsRepo(db);
// A reply left “streaming” after Bun was killed is marked interrupted.
conversations.stopOrphans();
const chatRuns = new ChatRuns({
  repo: conversations,
  target: () => {
    const s = runtime.supervisor.state;
    if (s.kind === 'external') return { host: null, port: s.port, profileId: null, modelPath: null };
    if (s.kind !== 'ready') return null;
    const p = profiles.get(s.profileId);
    return { host: s.host, port: s.port, profileId: s.profileId, modelPath: p ? profilePaths(p).model : null };
  },
});
const { supervisor, logs } = runtime;
// Compiled executable: NODE_ENV is replaced by "production" at compile time (`scripts/compile.ts`).
const development = process.env.NODE_ENV !== 'production';
const standalone = Bun.isStandaloneExecutable;
// Development: HTML import with HMR. Standalone executable: the same import, bundled (and split per page) at compile
// time and embedded. Production from source: front end built (and split per page) once, at startup; a front end that
// fails to build does not block the API or llama-server control.
const web =
  development || standalone
    ? { '/*': index }
    : await buildWebRoutes(`${import.meta.dir}/../web/index.html`).catch((err: unknown) => {
        console.error('[llama-webui] web UI unavailable:', err);
        return unavailableWebRoutes(err);
      });
const monitor = await startMonitor(runtime, settings.get());
const benchRuns = new BenchRunsRepo(db);
const sweeps = new SweepsRepo(db);
const benchGate = runtime.benchGate;
// Cold start: a run left “running” (Bun killed) is marked interrupted, and so is its sweep (Resume button).
// On reload the gate is still held: the old module has already settled its run and the new one resumes the sweep.
if (!benchGate.held) {
  benchRuns.stopOrphans();
  sweeps.stopOrphans();
}
const allGpus = () => monitor.latest()?.allGpus ?? [];
const executor = new RunExecutor({
  settings: () => settings.get(),
  logs,
  gpus: allGpus,
  disk: () => monitor.latest()?.disk?.model?.readBps ?? null,
  profile: (id) => {
    const p = profiles.get(id);
    return p ? { cwd: p.cwd, env: p.env } : null;
  },
});
const benchRunner = new BenchRunner({
  repo: benchRuns,
  sweeps,
  gate: benchGate,
  executor,
  hardware: () => readHardware(binaryPath(settings.get()), allGpus()),
  onLive: (l) => hub.broadcast({ type: 'bench-progress', payload: l }),
  onRun: (r) => hub.broadcast({ type: 'bench-run', payload: r }),
  onSweep: (s) => hub.broadcast({ type: 'sweep', payload: s }),
  onSweepLive: (l) => hub.broadcast({ type: 'sweep-progress', payload: l }),
  rebuild: (stopped) => {
    const p = profiles.get(stopped.profileId);
    return p ? buildCommand(p, settings.get()) : null;
  },
});
void benchRunner.resume();
monitor.setModelPathResolver((id) => {
  const p = profiles.get(id);
  return p ? profilePaths(p).model : null;
});
// Hugging Face downloads: recreated on every reload, the new queue resumes the `.part` the old one let go of.
const hf = new HfClient();
const downloadsRepo = new DownloadsRepo(db);
const downloads = new DownloadQueue({
  repo: downloadsRepo,
  hf,
  onItem: (i) => hub.broadcast({ type: 'download', payload: i }),
  onLive: (l) => hub.broadcast({ type: 'download-progress', payload: l }),
  onDeleted: (ids) => hub.broadcast({ type: 'download-deleted', payload: { ids } }),
});
downloads.resume();
// Model placement (startup logs): recreated on every reload, it replays the surviving ring.
const placement = new PlacementTracker({ logs, supervisor });

const server = createApp({
  db,
  hub,
  settings,
  profiles,
  conversations,
  chatRuns,
  benchRuns,
  benchRunner,
  sweeps,
  hf,
  downloads,
  downloadsRepo,
  runtime,
  monitor,
  placement,
  activeProfileId: () => activeProfileId(supervisor),
  web,
  hostname: HOSTNAME,
  port: PORT,
  development,
});

const unsubState = supervisor.subscribe(() => hub.broadcast({ type: 'server-state', payload: serverView(supervisor) }));
const unsubLogs = logs.onLines((lines) => hub.broadcast({ type: 'log', payload: lines }));
const unsubSnapshot = monitor.onSnapshot((s) => hub.broadcast({ type: 'snapshot', payload: s }));
const unsubPlacement = placement.onChange((p) => hub.broadcast({ type: 'placement', payload: p }));

// Bun shutdown: running replies are saved as “interrupted” before the runtime stops llama-server
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

const mode = development ? ' (dev, HMR)' : standalone ? ` (standalone ${APP_VERSION})` : '';
console.log(`llama-webui on http://${HOSTNAME}:${server.port}${mode}`);
