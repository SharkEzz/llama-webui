import type { Database } from "bun:sqlite";
import type { ChatRuns } from "./chat/runs";
import type { ConversationsRepo } from "./db/conversations";
import type { ProfilesRepo } from "./db/profiles";
import type { SettingsRepo } from "./db/settings";
import type { Monitor } from "./monitor/monitor";
import { chatRoutes } from "./routes/chat";
import { modelRoutes } from "./routes/models";
import { monitorRoutes } from "./routes/monitor";
import { profileRoutes } from "./routes/profiles";
import { serverRoutes } from "./routes/server";
import type { Runtime } from "./runtime";
import type { WsHub } from "./ws/hub";
import pkg from "./package.json";
import { guarded, jsonObject } from "./http";

export interface AppDeps {
  db: Database;
  hub: WsHub;
  settings: SettingsRepo;
  profiles: ProfilesRepo;
  conversations: ConversationsRepo;
  chatRuns: ChatRuns;
  activeProfileId: () => number | null;
  runtime: Runtime;
  monitor: Monitor;
  /** Page web (import HTML : Bun bundle React + Tailwind à la volée). */
  index: Bun.HTMLBundle;
  hostname: string;
  port: number;
  development: boolean;
}

const startedAt = Date.now();

export function createApp(deps: AppDeps) {
  const { hub, settings, monitor, index, port, development } = deps;
  return Bun.serve({
    port,
    hostname: deps.hostname,
    development: development ? { hmr: true, console: true } : false,
    routes: {
      "/api/health": {
        GET: guarded(() => Response.json({ ok: true, version: pkg.version, uptimeMs: Date.now() - startedAt })),
      },
      "/api/settings": {
        GET: guarded(() => Response.json(settings.get())),
        PATCH: guarded(async (req) => {
          const next = settings.patch(await jsonObject(req));
          await monitor.configure(next);
          return Response.json(next);
        }),
      },
      ...profileRoutes(deps),
      ...serverRoutes(deps),
      ...monitorRoutes({ monitor, bootId: deps.runtime.bootId }),
      ...modelRoutes(deps),
      ...chatRoutes(deps),
      "/api/*": guarded(() => Response.json({ error: "Route inconnue" }, { status: 404 })),
      "/ws": guarded((req, server) => {
        if (server.upgrade(req)) return undefined;
        return new Response("Upgrade WebSocket attendu", { status: 426 });
      }),
      // Toute autre adresse sert l'application (fallback SPA : /chat rechargé fonctionne).
      "/*": index,
    },
    websocket: {
      open: (ws) => hub.attach(ws),
      message: (ws, msg) => hub.receive(ws, msg),
      close: (ws) => hub.detach(ws),
    },
  });
}
