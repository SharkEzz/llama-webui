import index from "../web/index.html";
import { createApp } from "./app";
import { openDb } from "./db/open";
import { readHardware } from "./bench/hardware";
import { externalWatcher } from "./supervisor/external";
import { BenchRunner } from "./bench/runner";
import { ChatRuns } from "./chat/runs";
import { BenchRunsRepo } from "./db/benchRuns";
import { ConversationsRepo } from "./db/conversations";
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
const conversations = new ConversationsRepo(db);
// Une réponse restée « streaming » après un arrêt brutal de Bun est interrompue.
conversations.stopOrphans();
const chatRuns = new ChatRuns({
  repo: conversations,
  target: () => {
    const s = runtime.supervisor.state;
    if (s.kind === "external") return { port: s.port, profileId: null, modelPath: null };
    if (s.kind !== "ready") return null;
    const p = profiles.get(s.profileId);
    return { port: s.port, profileId: s.profileId, modelPath: p ? profilePaths(p).model : null };
  },
});
const { supervisor, logs } = runtime;
const development = process.env.NODE_ENV !== "production";
const monitor = await startMonitor(runtime, settings.get());
const benchRuns = new BenchRunsRepo(db);
// Un run resté « running » après un arrêt brutal de Bun est interrompu.
benchRuns.stopOrphans();
const allGpus = () => monitor.latest()?.allGpus ?? [];
const benchRunner = new BenchRunner({
  repo: benchRuns,
  settings: () => settings.get(),
  server: supervisor,
  logs,
  gpus: allGpus,
  hardware: () => readHardware(settings.get().binary, allGpus()),
  onLive: (l) => hub.broadcast({ type: "bench-progress", payload: l }),
  onRun: (r) => hub.broadcast({ type: "bench-run", payload: r }),
  profile: (id) => {
    const p = profiles.get(id);
    return p ? { cwd: p.cwd, env: p.env } : null;
  },
});
monitor.setModelPathResolver((id) => {
  const p = profiles.get(id);
  return p ? profilePaths(p).model : null;
});

const server = createApp({
  db,
  hub,
  settings,
  profiles,
  conversations,
  chatRuns,
  benchRuns,
  benchRunner,
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

// Arrêt de Bun : les réponses en cours sont enregistrées « interrompues » avant que le runtime n'arrête llama-server
// (sinon elles verraient la coupure et finiraient « erreur »). En tête de file, devant le gestionnaire du runtime.
const stopChats = () => {
  chatRuns.dispose();
  benchRunner.dispose({ restart: false });
};
process.prependListener("SIGINT", stopChats);
process.prependListener("SIGTERM", stopChats);

// Serveur externe : détecté au démarrage puis surveillé (sortie de l'état « external » quand il s'arrête).
const checkExternal = externalWatcher({ supervisor, port: () => settings.get().port, paused: () => benchRunner.busy });
void checkExternal();
const externalTimer = setInterval(() => void checkExternal(), EXTERNAL_CHECK_MS);

g.__llamaWebuiDispose = () => {
  clearInterval(externalTimer);
  unsubState();
  unsubLogs();
  unsubSnapshot();
  monitor.setModelPathResolver(() => null);
  hub.dispose();
  process.off("SIGINT", stopChats);
  process.off("SIGTERM", stopChats);
  chatRuns.dispose();
  // Rechargement : le run est interrompu et le serveur qu'il avait arrêté relancé (le superviseur survit).
  benchRunner.dispose({ restart: true });
  db.close();
};

console.log(`llama-webui sur http://${HOSTNAME}:${server.port}${development ? " (dev, HMR)" : ""}`);
