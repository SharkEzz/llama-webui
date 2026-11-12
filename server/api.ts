import { Hono } from 'hono';
import type { BenchRunner } from './bench/runner';
import type { ChatRuns } from './chat/runs';
import type { BenchRunsRepo } from './db/benchRuns';
import type { ConversationsRepo } from './db/conversations';
import type { DownloadsRepo } from './db/downloads';
import type { ProfilesRepo } from './db/profiles';
import type { SettingsRepo } from './db/settings';
import type { Database } from './db/sqlite';
import type { SweepsRepo } from './db/sweeps';
import type { HfClient } from './hf/client';
import type { DownloadQueue } from './hf/downloader';
import { allowTable, apiRoutes, type Env, errorResponse, guardMw, jsonCharset } from './http';
import type { Monitor } from './monitor/monitor';
import type { PlacementTracker } from './monitor/placement';
import { benchRoutes } from './routes/bench';
import { chatRoutes } from './routes/chat';
import { hfRoutes } from './routes/hf';
import { modelRoutes } from './routes/models';
import { monitorRoutes } from './routes/monitor';
import { profileRoutes } from './routes/profiles';
import { serverRoutes } from './routes/server';
import { settingsRoutes } from './routes/settings';
import { setupRoutes } from './routes/setup';
import { sweepRoutes } from './routes/sweeps';
import { topologyRoutes } from './routes/topology';
import { tuningRoutes } from './routes/tuning';
import type { Runtime } from './runtime';
import { APP_VERSION } from './version';
import type { WsHub } from './ws/hub';

/** The objects the API is made of (`createDeps()`, `server/deps.ts`). */
export interface AppDeps {
  db: Database;
  hub: WsHub;
  settings: SettingsRepo;
  profiles: ProfilesRepo;
  conversations: ConversationsRepo;
  chatRuns: ChatRuns;
  benchRuns: BenchRunsRepo;
  benchRunner: BenchRunner;
  sweeps: SweepsRepo;
  /** Hugging Face Hub client and download queue (Models page). */
  hf: HfClient;
  downloads: DownloadQueue;
  downloadsRepo: DownloadsRepo;
  activeProfileId: () => number | null;
  runtime: Runtime;
  monitor: Monitor;
  /** Placement of the loaded model (from llama-server logs), for the Topology page. */
  placement: PlacementTracker;
  /** The listen address (`--host`): the first-run checks say whether the UI is open to the network. */
  hostname: string;
}

const startedAt = Date.now();

/**
 * The HTTP API (`/api/*`): one chained Hono app, one `.route()` per domain file. Every request goes through the
 * charset fix, the guard (host, origin, JSON) and the 405 table first; within a domain file, a static path is
 * registered before the `:param` pattern that would catch it (Hono matches in registration order).
 */
export function createApi(deps: AppDeps) {
  const { settings, monitor } = deps;
  const allow = allowTable();
  const api = new Hono<Env>()
    .use(jsonCharset, guardMw, allow.mw)
    .get('/api/health', (c) => c.json({ ok: true, version: APP_VERSION, uptimeMs: Date.now() - startedAt }))
    .route('/', settingsRoutes({ settings, monitor }))
    .route('/', profileRoutes(deps))
    .route('/', serverRoutes({ ...deps, benchBusy: () => deps.benchRunner.busy }))
    .route('/', monitorRoutes({ monitor, bootId: deps.runtime.bootId }))
    .route('/', topologyRoutes(deps))
    .route('/', setupRoutes(deps))
    .route('/', modelRoutes(deps))
    .route('/', hfRoutes(deps))
    .route('/', tuningRoutes(deps))
    .route('/', chatRoutes(deps))
    .route('/', benchRoutes(deps))
    .route('/', sweepRoutes(deps));
  allow.load(apiRoutes(api));
  api.notFound((c) => c.json({ error: 'Unknown route' }, 404));
  api.onError((err) => errorResponse(err));
  return api;
}

export type AppType = ReturnType<typeof createApi>;
