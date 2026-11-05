import type { Database } from "bun:sqlite";
import { ZodError } from "zod";
import type { SettingsRepo } from "./db/settings";
import type { WsHub } from "./ws/hub";
import { serveStatic } from "./static";
import pkg from "./package.json";

export interface AppDeps {
  db: Database;
  hub: WsHub;
  settings: SettingsRepo;
  distDir: string;
  port: number;
}

const startedAt = Date.now();

function errorResponse(err: unknown): Response {
  if (err instanceof ZodError) {
    return Response.json({ error: "Réglages invalides", issues: err.issues }, { status: 400 });
  }
  if (err instanceof SyntaxError) {
    return Response.json({ error: "JSON invalide" }, { status: 400 });
  }
  console.error(err);
  return Response.json({ error: "Erreur interne" }, { status: 500 });
}

export function createApp(deps: AppDeps) {
  const { hub, settings, distDir, port } = deps;
  return Bun.serve({
    port,
    hostname: "127.0.0.1",
    routes: {
      "/api/health": {
        GET: () => Response.json({ ok: true, version: pkg.version, uptimeMs: Date.now() - startedAt }),
      },
      "/api/settings": {
        GET: () => Response.json(settings.get()),
        PATCH: async (req) => {
          try {
            const body = await req.json();
            if (typeof body !== "object" || body === null || Array.isArray(body)) {
              return Response.json({ error: "Objet JSON attendu" }, { status: 400 });
            }
            return Response.json(settings.patch(body));
          } catch (err) {
            return errorResponse(err);
          }
        },
      },
      "/api/*": () => Response.json({ error: "Route inconnue" }, { status: 404 }),
    },
    fetch(req, server) {
      if (new URL(req.url).pathname === "/ws") {
        if (server.upgrade(req)) return undefined;
        return new Response("Upgrade WebSocket attendu", { status: 426 });
      }
      return serveStatic(req, distDir) ?? new Response("Méthode non autorisée", { status: 405 });
    },
    websocket: {
      open: (ws) => hub.attach(ws),
      message: (ws, msg) => hub.receive(ws, msg),
      close: (ws) => hub.detach(ws),
    },
  });
}
