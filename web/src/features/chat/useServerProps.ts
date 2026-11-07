import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { useServer } from '@/lib/server';

/** What llama-server's /props says about default sampling, context and the loaded model. */
export interface ServerProps {
  model_path?: string;
  default_generation_settings?: { n_ctx?: number; params?: Record<string, unknown> };
}

/** /props of the ready server (reread on every state change), otherwise null. */
export function useServerProps(): ServerProps | null {
  const kind = useServer((s) => s.view?.state.kind);
  const pid = useServer((s) => (s.view && 'pid' in s.view.state ? s.view.state.pid : null));
  const [props, setProps] = useState<ServerProps | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: pid is a trigger: /props is reread on every server restart
  useEffect(() => {
    if (kind !== 'ready' && kind !== 'external') {
      setProps(null);
      return;
    }
    let live = true;
    api<ServerProps>('/server/props').then(
      (p) => live && setProps(p),
      () => live && setProps(null),
    );
    return () => {
      live = false;
    };
  }, [kind, pid]);
  return props;
}
