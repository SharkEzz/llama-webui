import { defer, type ServerState } from '@llama-webui/shared';

export interface ExternalWatcherDeps {
  supervisor: {
    readonly state: ServerState;
    detectExternal(port: number): Promise<boolean>;
    recheckExternal(): Promise<void>;
  };
  /** Ports to watch: the settings' one and the last one a profile used (#28). */
  ports(): (number | null | undefined)[];
  /** True during a benchmark: the llama-server it starts on the settings port is not an external server. */
  paused(): boolean;
}

/**
 * External server detection (at startup then periodically), and leaving the “external” state when it stops. Detection
 * runs while idle and after a crash (a llama-server started by hand on the port, #39).
 */
export function externalWatcher(d: ExternalWatcherDeps): () => Promise<void> {
  let checking = false;
  return async () => {
    if (checking || d.paused()) return;
    checking = true;
    using _check = defer(() => (checking = false));
    const kind = d.supervisor.state.kind;
    if (kind === 'external') await d.supervisor.recheckExternal();
    else if (kind === 'idle' || kind === 'crashed')
      for (const port of new Set(d.ports().filter((p): p is number => typeof p === 'number')))
        if (await d.supervisor.detectExternal(port)) return;
  };
}
