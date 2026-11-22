import { useEffect, useState } from 'react';
import { getServerProps, type ServerProps, serverPropsOf } from '@/lib/props';
import { useServer } from '@/lib/server';

export type { ServerProps };

/** /props of the ready or sleeping server (reread when the running process changes), otherwise null. */
export function useServerProps(): ServerProps | null {
  const kind = useServer((s) => s.view?.state.kind);
  const pid = useServer((s) => (s.view && 'pid' in s.view.state ? s.view.state.pid : null));
  const liveGroup = kind === 'external' ? 'external' : kind === 'ready' || kind === 'sleeping' ? 'managed' : null;
  const [props, setProps] = useState<ServerProps | null>(null);
  // Out of ready/sleeping, no props: cleared by the render that leaves it, before the effect of the next state
  if (liveGroup === null && props !== null) setProps(null);
  useEffect(() => {
    if (liveGroup === null) return;
    let live = true;
    getServerProps().then(
      (p) => live && setProps(serverPropsOf(p)),
      () => live && setProps(null),
    );
    return () => {
      live = false;
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- pid is a trigger: /props is reread on every server restart
  }, [liveGroup, pid]);
  return props;
}
