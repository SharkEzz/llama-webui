import { createApp } from "./app";
import { openDb } from "./db/open";
import { SettingsRepo } from "./db/settings";
import { dbPath } from "./paths";
import { WsHub } from "./ws/hub";
import index from "../web/index.html";

const PORT = 7860;
// Écoute locale par défaut ; LLAMA_WEBUI_HOST=0.0.0.0 pour ouvrir au réseau local (aucune authentification).
const HOSTNAME = process.env.LLAMA_WEBUI_HOST || "127.0.0.1";

// Sous `bun --hot`, ce module est réévalué : on libère l'instance précédente (timers, db).
const g = globalThis as { __llamaWebuiDispose?: () => void };
g.__llamaWebuiDispose?.();

const db = openDb(dbPath());
const hub = new WsHub();
const settings = new SettingsRepo(db);
const development = process.env.NODE_ENV !== "production";
const server = createApp({ db, hub, settings, index, hostname: HOSTNAME, port: PORT, development });

g.__llamaWebuiDispose = () => {
  hub.dispose();
  db.close();
};

console.log(`llama-webui sur http://${HOSTNAME}:${server.port}${development ? " (dev, HMR)" : ""}`);
