import type { Database } from 'bun:sqlite';
import type { BenchRunner } from './bench/runner';
import type { ChatRuns } from './chat/runs';
import type { BenchRunsRepo } from './db/benchRuns';
import type { ConversationsRepo } from './db/conversations';
import type { ProfilesRepo } from './db/profiles';
import type { SettingsRepo } from './db/settings';
import type { SweepsRepo } from './db/sweeps';
import { guarded, jsonObject } from './http';
import type { Monitor } from './monitor/monitor';
import type { PlacementTracker } from './monitor/placement';
import pkg from './package.json';
import { benchRoutes } from './routes/bench';
import { chatRoutes } from './routes/chat';
import { modelRoutes } from './routes/models';
import { monitorRoutes } from './routes/monitor';
import { profileRoutes } from './routes/profiles';
import { serverRoutes } from './routes/server';
import { sweepRoutes } from './routes/sweeps';
import { topologyRoutes } from './routes/topology';
import { tuningRoutes } from './routes/tuning';
import type { WebRoutes } from './routes/web';
import type { Runtime } from './runtime';
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

const startedAt = Date.now();

export function createApp(deps: AppDeps) {
  const { hub, settings, monitor, port, development } = deps;
  return Bun.serve({
    port,
    hostname: deps.hostname,
    development: development ? { hmr: true, console: true } : false,
    routes: {
      '/api/health': {
        GET: guarded(() => Response.json({ ok: true, version: pkg.version, uptimeMs: Date.now() - startedAt })),
      },
      '/api/settings': {
        GET: guarded(() => Response.json(settings.get())),
        PATCH: guarded(async (req) => {
          const next = settings.patch(await jsonObject(req));
          await monitor.configure(next);
          return Response.json(next);
        }),
      },
      ...profileRoutes(deps),
      ...serverRoutes({ ...deps, benchBusy: () => deps.benchRunner.busy }),
      ...monitorRoutes({ monitor, bootId: deps.runtime.bootId }),
      ...modelRoutes(deps),
      ...chatRoutes(deps),
      ...benchRoutes(deps),
      ...sweepRoutes(deps),
      ...tuningRoutes(deps),
      ...topologyRoutes(deps),
      '/api/*': guarded(() => Response.json({ error: 'Unknown route' }, { status: 404 })),
      '/ws': guarded((req, server) => {
        if (server.upgrade(req)) return undefined;
        return new Response('WebSocket upgrade expected', { status: 426 });
      }),
      // Any other path serves the app (SPA fallback `/*`: reloading /chat works).
      ...deps.web,
    },
    websocket: {
      open: (ws) => hub.attach(ws),
      message: (ws, msg) => hub.receive(ws, msg),
      close: (ws) => hub.detach(ws),
    },
  });
}
