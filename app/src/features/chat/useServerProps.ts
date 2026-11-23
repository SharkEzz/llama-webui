import { servesRequests } from '@llama-webui/shared';
import { useEffect, useState } from 'react';
import { getServerProps, type ServerProps, serverPropsOf } from '@/lib/props';
import { useServer } from '@/lib/server';

export type { ServerProps };

/** /props of the server that takes requests (reread when the running process changes), otherwise null. */
export function useServerProps(): ServerProps | null {
  const kind = useServer((s) => s.view?.state.kind);
  const serving = useServer((s) => servesRequests(s.view?.state));
  const pid = useServer((s) => (s.view && 'pid' in s.view.state ? s.view.state.pid : null));
  // One group for ready, sleeping and waking up: the same process, its /props are not reread on a sleep or a wake-up
  const liveGroup = !serving ? null : kind === 'external' ? 'external' : 'managed';
  const [props, setProps] = useState<ServerProps | null>(null);
  // Out of those states, no props: cleared by the render that leaves it, before the effect of the next state
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
