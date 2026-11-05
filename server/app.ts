import type { Database } from "bun:sqlite";
import type { ProfilesRepo } from "./db/profiles";
import type { SettingsRepo } from "./db/settings";
import { profileRoutes } from "./routes/profiles";
import type { WsHub } from "./ws/hub";
import pkg from "./package.json";
import { guarded, jsonObject } from "./http";

export interface AppDeps {
  db: Database;
  hub: WsHub;
  settings: SettingsRepo;
  profiles: ProfilesRepo;
  activeProfileId: () => number | null;
  /** Page web (import HTML : Bun bundle React + Tailwind à la volée). */
  index: Bun.HTMLBundle;
  hostname: string;
  port: number;
  development: boolean;
}

const startedAt = Date.now();

export function createApp(deps: AppDeps) {
  const { hub, settings, index, port, development } = deps;
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
        PATCH: guarded(async (req) => Response.json(settings.patch(await jsonObject(req)))),
      },
      ...profileRoutes(deps),
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
