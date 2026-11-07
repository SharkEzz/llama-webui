import index from '../web/index.html';
import { createApp } from './app';
import { RunExecutor } from './bench/execute';
import { readHardware } from './bench/hardware';
import { BenchRunner } from './bench/runner';
import { ChatRuns } from './chat/runs';
import { cliOptionsOrExit } from './cli';
import { BenchRunsRepo } from './db/benchRuns';
import { ConversationsRepo } from './db/conversations';
import { openDb } from './db/open';
import { ProfilesRepo } from './db/profiles';
import { SettingsRepo } from './db/settings';
import { SweepsRepo } from './db/sweeps';
import { PlacementTracker } from './monitor/placement';
import { dbPath } from './paths';
import { buildWebRoutes, unavailableWebRoutes } from './routes/web';
import { activeProfileId, getRuntime, serverView, startMonitor } from './runtime';
import { profilePaths } from './supervisor/args';
import { externalWatcher } from './supervisor/external';
import { WsHub } from './ws/hub';

// Flags, sinon env, sinon défauts (`--help`). Écoute locale par défaut ; --host 0.0.0.0 (ou LLAMA_WEBUI_HOST) pour
// ouvrir au réseau local (aucune authentification). Relu à chaque rechargement `bun --hot` : mêmes arguments.
const cli = cliOptionsOrExit();
const HOSTNAME = cli.host;
const PORT = cli.port;
const EXTERNAL_CHECK_MS = 2000;

// Sous `bun --hot`, ce module est réévalué : on libère l'instance précédente (timers, db, abonnements).
// Le superviseur et les logs (runtime) survivent au rechargement.
const g = globalThis as { __llamaWebuiDispose?: () => void };
g.__llamaWebuiDispose?.();

const db = openDb(dbPath(cli.dataDir));
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
    if (s.kind === 'external') return { port: s.port, profileId: null, modelPath: null };
    if (s.kind !== 'ready') return null;
    const p = profiles.get(s.profileId);
    return { port: s.port, profileId: s.profileId, modelPath: p ? profilePaths(p).model : null };
  },
});
const { supervisor, logs } = runtime;
const development = process.env.NODE_ENV !== 'production';
// Production : front construit (et découpé par page) une fois, au démarrage ; développement : import HTML avec HMR.
// Un front qui ne se construit pas n'empêche pas l'API ni le pilotage de llama-server.
const web = development
  ? { '/*': index }
  : await buildWebRoutes(`${import.meta.dir}/../web/index.html`).catch((err: unknown) => {
      console.error('[llama-webui] interface web indisponible :', err);
      return unavailableWebRoutes(err);
    });
const monitor = await startMonitor(runtime, settings.get());
const benchRuns = new BenchRunsRepo(db);
const sweeps = new SweepsRepo(db);
const benchGate = runtime.benchGate;
// Démarrage à froid : un run resté « running » (arrêt brutal de Bun) est interrompu, son sweep aussi (bouton Reprendre).
// Au rechargement la garde est encore tenue : l'ancien module a déjà rangé son run et le nouveau reprend le sweep.
if (!benchGate.held) {
  benchRuns.stopOrphans();
  sweeps.stopOrphans();
}
const allGpus = () => monitor.latest()?.allGpus ?? [];
const executor = new RunExecutor({
  settings: () => settings.get(),
  logs,
  gpus: allGpus,
  disk: () => monitor.latest()?.disk?.model?.readBps ?? null,
  profile: (id) => {
    const p = profiles.get(id);
    return p ? { cwd: p.cwd, env: p.env } : null;
  },
});
const benchRunner = new BenchRunner({
  repo: benchRuns,
  sweeps,
  gate: benchGate,
  executor,
  hardware: () => readHardware(settings.get().binary, allGpus()),
  onLive: (l) => hub.broadcast({ type: 'bench-progress', payload: l }),
  onRun: (r) => hub.broadcast({ type: 'bench-run', payload: r }),
  onSweep: (s) => hub.broadcast({ type: 'sweep', payload: s }),
  onSweepLive: (l) => hub.broadcast({ type: 'sweep-progress', payload: l }),
});
void benchRunner.resume();
monitor.setModelPathResolver((id) => {
  const p = profiles.get(id);
  return p ? profilePaths(p).model : null;
});
// Répartition du modèle (logs de démarrage) : recréé à chaque rechargement, il rejoue le ring qui survit.
const placement = new PlacementTracker({ logs, supervisor });

const server = createApp({
  db,
  hub,
  settings,
  profiles,
  conversations,
  chatRuns,
  benchRuns,
  benchRunner,
  sweeps,
  runtime,
  monitor,
  placement,
  activeProfileId: () => activeProfileId(supervisor),
  web,
  hostname: HOSTNAME,
  port: PORT,
  development,
});

const unsubState = supervisor.subscribe(() => hub.broadcast({ type: 'server-state', payload: serverView(supervisor) }));
const unsubLogs = logs.onLines((lines) => hub.broadcast({ type: 'log', payload: lines }));
const unsubSnapshot = monitor.onSnapshot((s) => hub.broadcast({ type: 'snapshot', payload: s }));
const unsubPlacement = placement.onChange((p) => hub.broadcast({ type: 'placement', payload: p }));

// Arrêt de Bun : les réponses en cours sont enregistrées « interrompues » avant que le runtime n'arrête llama-server
// (sinon elles verraient la coupure et finiraient « erreur »). En tête de file, devant le gestionnaire du runtime.
const stopChats = () => {
  chatRuns.dispose();
  benchRunner.dispose({ restart: false });
};
process.prependListener('SIGINT', stopChats);
process.prependListener('SIGTERM', stopChats);

// Serveur externe : détecté au démarrage puis surveillé (sortie de l'état « external » quand il s'arrête).
const checkExternal = externalWatcher({
  supervisor,
  port: () => settings.get().port,
  paused: () => benchGate.held || benchRunner.busy,
});
void checkExternal();
const externalTimer = setInterval(() => void checkExternal(), EXTERNAL_CHECK_MS);

g.__llamaWebuiDispose = () => {
  clearInterval(externalTimer);
  unsubState();
  unsubLogs();
  unsubSnapshot();
  unsubPlacement();
  placement.dispose();
  monitor.setModelPathResolver(() => null);
  hub.dispose();
  process.off('SIGINT', stopChats);
  process.off('SIGTERM', stopChats);
  chatRuns.dispose();
  // Rechargement : le run ponctuel est interrompu, l'élément de sweep remis en attente ; la garde (runtime) passe au
  // nouveau module, ou relance le serveur si personne ne la reprend.
  benchRunner.dispose({ restart: true });
  db.close();
};

console.log(`llama-webui sur http://${HOSTNAME}:${server.port}${development ? ' (dev, HMR)' : ''}`);
