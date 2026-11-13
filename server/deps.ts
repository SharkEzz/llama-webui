import type { AppDeps } from './api';
import { RunExecutor } from './bench/execute';
import { readHardware } from './bench/hardware';
import { BenchRunner } from './bench/runner';
import { ChatRuns } from './chat/runs';
import { BenchRunsRepo } from './db/benchRuns';
import { ConversationsRepo } from './db/conversations';
import { DownloadsRepo } from './db/downloads';
import { ProfilesRepo } from './db/profiles';
import { SettingsRepo } from './db/settings';
import type { Database } from './db/sqlite';
import { SweepsRepo } from './db/sweeps';
import { HfClient } from './hf/client';
import { DownloadQueue } from './hf/downloader';
import type { Monitor } from './monitor/monitor';
import { PlacementTracker } from './monitor/placement';
import { activeProfileId, type Runtime } from './runtime';
import { binaryPath, buildCommand, profilePaths } from './supervisor/args';
import { WsHub } from './ws/hub';

export interface DepsOptions {
  db: Database;
  runtime: Runtime;
  monitor: Monitor;
  hostname: string;
  /** Hugging Face Hub and CDN requests (the contract suite passes one that never reaches the network). */
  fetch?: typeof fetch;
}

/**
 * The objects the app is made of, wired together: repositories, chat runs, the bench runner, the Hugging Face client
 * and download queue, the placement tracker and the WebSocket hub. Constructors only: what starts work or touches
 * existing rows (orphans, resume, subscriptions, signals) is left to the caller, `server/index.ts`.
 */
export function createDeps(o: DepsOptions): AppDeps {
  const { db, runtime, monitor } = o;
  const { supervisor, logs, benchGate } = runtime;
  const hub = new WsHub(runtime.bootId);
  const settings = new SettingsRepo(db);
  const profiles = new ProfilesRepo(db);
  const conversations = new ConversationsRepo(db);
  const chatRuns = new ChatRuns({
    repo: conversations,
    target: () => {
      const s = supervisor.state;
      if (s.kind === 'external') return { host: null, port: s.port, profileId: null, modelPath: null };
      if (s.kind !== 'ready') return null;
      const p = profiles.get(s.profileId);
      return { host: s.host, port: s.port, profileId: s.profileId, modelPath: p ? profilePaths(p).model : null };
    },
  });
  const benchRuns = new BenchRunsRepo(db);
  const sweeps = new SweepsRepo(db);
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
  const hf = new HfClient(o.fetch ? { fetch: o.fetch } : {});
  const downloadsRepo = new DownloadsRepo(db);
  const downloads = new DownloadQueue({
    repo: downloadsRepo,
    hf,
    ...(o.fetch ? { fetch: o.fetch } : {}),
    onItem: (i) => hub.broadcast({ type: 'download', payload: i }),
    onLive: (l) => hub.broadcast({ type: 'download-progress', payload: l }),
    onDeleted: (ids) => hub.broadcast({ type: 'download-deleted', payload: { ids } }),
  });
  // Model placement (startup logs): it replays the ring, then follows it.
  const placement = new PlacementTracker({ logs, supervisor });
  return {
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
    hostname: o.hostname,
  };
}
