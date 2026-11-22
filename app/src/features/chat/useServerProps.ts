import { useEffect, useState } from 'react';
import { getServerProps, type ServerProps, serverPropsOf } from '@/lib/props';
import { useServer } from '@/lib/server';

export type { ServerProps };

/** /props of the ready server (reread on every state change), otherwise null. */
export function useServerProps(): ServerProps | null {
  const kind = useServer((s) => s.view?.state.kind);
  const pid = useServer((s) => (s.view && 'pid' in s.view.state ? s.view.state.pid : null));
  const ready = kind === 'ready' || kind === 'external';
  const [props, setProps] = useState<ServerProps | null>(null);
  // Out of ready, no props: cleared by the render that leaves it, before the effect of the next state
  if (!ready && props !== null) setProps(null);
  useEffect(() => {
    if (kind !== 'ready' && kind !== 'external') return;
    let live = true;
    getServerProps().then(
      (p) => live && setProps(serverPropsOf(p)),
      () => live && setProps(null),
    );
    return () => {
      live = false;
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- pid is a trigger: /props is reread on every server restart
  }, [kind, pid]);
  return props;
}
