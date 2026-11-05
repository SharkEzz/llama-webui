import type { ServerView } from "@llama-webui/shared";
import { LogBuffer } from "./logs/buffer";
import { Supervisor } from "./supervisor/supervisor";

export interface Runtime {
  supervisor: Supervisor;
  logs: LogBuffer;
  /** Identifiant de ce démarrage de llama-webui (stable à travers bun --hot) : le client y rattache la numérotation des logs. */
  bootId: string;
}

const g = globalThis as { __llamaWebuiRuntime?: Runtime };

/**
 * Superviseur et ring de logs uniques pour tout le process. Ils vivent sur globalThis pour survivre à `bun --hot`
 * (un rechargement de code ne doit ni tuer ni orpheliner llama-server). Les signaux d'arrêt sont installés une seule fois.
 * Conséquence : modifier supervisor.ts, logs/buffer.ts ou ce fichier demande un redémarrage complet de Bun.
 */
export function getRuntime(): Runtime {
  if (g.__llamaWebuiRuntime) return g.__llamaWebuiRuntime;
  const logs = new LogBuffer(10_000);
  const supervisor = new Supervisor({ logs });
  const rt: Runtime = { supervisor, logs, bootId: crypto.randomUUID() };
  g.__llamaWebuiRuntime = rt;

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    if (supervisor.managedPid !== null) console.log(`[llama-webui] ${signal} : arrêt de llama-server…`);
    await supervisor.stop().catch(() => {});
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("exit", () => supervisor.killNow());
  return rt;
}

export function serverView(supervisor: Supervisor): ServerView {
  const state = supervisor.state;
  const last = supervisor.lastCommand;
  return {
    state,
    command: last?.display ?? null,
    profileId: "profileId" in state ? state.profileId : (last?.profileId ?? null),
  };
}

/** Profil du serveur géré tant qu'il tourne (pas après un crash). */
export function activeProfileId(supervisor: Supervisor): number | null {
  const s = supervisor.state;
  return s.kind === "starting" || s.kind === "ready" || s.kind === "stopping" ? s.profileId : null;
}
