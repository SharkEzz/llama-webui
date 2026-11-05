import index from "../web/index.html";
import { createApp } from "./app";
import { openDb } from "./db/open";
import { ProfilesRepo } from "./db/profiles";
import { SettingsRepo } from "./db/settings";
import { dbPath } from "./paths";
import { activeProfileId, getRuntime, serverView, startMonitor } from "./runtime";
import { profilePaths } from "./supervisor/args";
import { WsHub } from "./ws/hub";

const PORT = 7860;
// Écoute locale par défaut ; LLAMA_WEBUI_HOST=0.0.0.0 pour ouvrir au réseau local (aucune authentification).
const HOSTNAME = process.env.LLAMA_WEBUI_HOST || "127.0.0.1";
const EXTERNAL_CHECK_MS = 2000;

// Sous `bun --hot`, ce module est réévalué : on libère l'instance précédente (timers, db, abonnements).
// Le superviseur et les logs (runtime) survivent au rechargement.
const g = globalThis as { __llamaWebuiDispose?: () => void };
g.__llamaWebuiDispose?.();

const db = openDb(dbPath());
const runtime = getRuntime();
const hub = new WsHub(runtime.bootId);
const settings = new SettingsRepo(db);
const profiles = new ProfilesRepo(db);
const { supervisor, logs } = runtime;
const development = process.env.NODE_ENV !== "production";
const monitor = await startMonitor(runtime, settings.get());
monitor.setModelPathResolver((id) => {
  const p = profiles.get(id);
  return p ? profilePaths(p).model : null;
});

const server = createApp({
  db,
  hub,
  settings,
  profiles,
  runtime,
  monitor,
  activeProfileId: () => activeProfileId(supervisor),
  index,
  hostname: HOSTNAME,
  port: PORT,
  development,
});

const unsubState = supervisor.subscribe(() => hub.broadcast({ type: "server-state", payload: serverView(supervisor) }));
const unsubLogs = logs.onLines((lines) => hub.broadcast({ type: "log", payload: lines }));
const unsubSnapshot = monitor.onSnapshot((s) => hub.broadcast({ type: "snapshot", payload: s }));

// Serveur externe : détecté au démarrage puis surveillé (sortie de l'état « external » quand il s'arrête).
let checking = false;
const checkExternal = async () => {
  if (checking) return;
  checking = true;
  try {
    const kind = supervisor.state.kind;
    if (kind === "external") await supervisor.recheckExternal();
    else if (kind === "idle") await supervisor.detectExternal(settings.get().port);
  } finally {
    checking = false;
  }
};
void checkExternal();
const externalTimer = setInterval(() => void checkExternal(), EXTERNAL_CHECK_MS);

g.__llamaWebuiDispose = () => {
  clearInterval(externalTimer);
  unsubState();
  unsubLogs();
  unsubSnapshot();
  monitor.setModelPathResolver(() => null);
  hub.dispose();
  db.close();
};

console.log(`llama-webui sur http://${HOSTNAME}:${server.port}${development ? " (dev, HMR)" : ""}`);
