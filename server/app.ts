import type { Server } from 'bun';
import { createApi } from './api';
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
import type { Monitor } from './monitor/monitor';
import type { PlacementTracker } from './monitor/placement';
import type { WebRoutes } from './routes/web';
import type { Runtime } from './runtime';
import { guard } from './security';
import type { WsHub } from './ws/hub';

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
  /** Web UI: HTML import (development, HMR) or files built at startup (production). */
  web: WebRoutes;
  hostname: string;
  port: number;
  development: boolean;
}

/** Every route of the app for `Bun.serve`: `/api/*` → the Hono API, `/ws`, then the UI. */
function appRoutes(deps: AppDeps) {
  const api = createApi(deps);
  return {
    '/api/*': (req: Request, server: Server<undefined>) => api.fetch(req, { server }),
    '/ws': (req: Request, server: Server<undefined>) => {
      const refused = guard(req);
      if (refused) return refused;
      if (server.upgrade(req)) return undefined;
      return new Response('WebSocket upgrade expected', { status: 426 });
    },
    // Any other path serves the app (SPA fallback `/*`: reloading /chat works).
    ...deps.web,
  };
}

export function createApp(deps: AppDeps) {
  const { hub, port, development } = deps;
  return Bun.serve({
    port,
    hostname: deps.hostname,
    development: development ? { hmr: true, console: true } : false,
    routes: appRoutes(deps),
    websocket: {
      open: (ws) => hub.attach(ws),
      message: (ws, msg) => hub.receive(ws, msg),
      close: (ws) => hub.detach(ws),
    },
  });
}
