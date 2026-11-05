import type { ServerState } from "@llama-webui/shared";

export interface ExternalWatcherDeps {
  supervisor: {
    readonly state: ServerState;
    detectExternal(port: number): Promise<boolean>;
    recheckExternal(): Promise<void>;
  };
  port(): number;
  /** Vrai pendant un benchmark : le llama-server qu'il lance sur le port des réglages n'est pas un serveur externe. */
  paused(): boolean;
}

/** Détection du serveur externe (au démarrage puis périodiquement), et sortie de l'état « external » quand il s'arrête. */
export function externalWatcher(d: ExternalWatcherDeps): () => Promise<void> {
  let checking = false;
  return async () => {
    if (checking || d.paused()) return;
    checking = true;
    try {
      const kind = d.supervisor.state.kind;
      if (kind === "external") await d.supervisor.recheckExternal();
      else if (kind === "idle") await d.supervisor.detectExternal(d.port());
    } finally {
      checking = false;
    }
  };
}
