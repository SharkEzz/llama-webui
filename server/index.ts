import { resolve } from "node:path";
import { createApp } from "./app";
import { openDb } from "./db/open";
import { SettingsRepo } from "./db/settings";
import { dbPath } from "./paths";
import { WsHub } from "./ws/hub";

const PORT = 7860;

// Sous `bun --hot`, ce module est réévalué : on libère l'instance précédente (timers, db).
const g = globalThis as { __llamaWebuiDispose?: () => void };
g.__llamaWebuiDispose?.();

const db = openDb(dbPath());
const hub = new WsHub();
const settings = new SettingsRepo(db);
const distDir = resolve(import.meta.dir, "../web/dist");
const server = createApp({ db, hub, settings, distDir, port: PORT });

g.__llamaWebuiDispose = () => {
  hub.dispose();
  db.close();
};

console.log(`llama-webui sur http://127.0.0.1:${server.port}`);
