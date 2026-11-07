import { defer, type ServerState } from '@llama-webui/shared';

export interface ExternalWatcherDeps {
  supervisor: {
    readonly state: ServerState;
    detectExternal(port: number): Promise<boolean>;
    recheckExternal(): Promise<void>;
  };
  port(): number;
  /** True during a benchmark: the llama-server it starts on the settings port is not an external server. */
  paused(): boolean;
}

/** External server detection (at startup then periodically), and leaving the “external” state when it stops. */
export function externalWatcher(d: ExternalWatcherDeps): () => Promise<void> {
  let checking = false;
  return async () => {
    if (checking || d.paused()) return;
    checking = true;
    using _check = defer(() => (checking = false));
    const kind = d.supervisor.state.kind;
    if (kind === 'external') await d.supervisor.recheckExternal();
    else if (kind === 'idle') await d.supervisor.detectExternal(d.port());
  };
}
