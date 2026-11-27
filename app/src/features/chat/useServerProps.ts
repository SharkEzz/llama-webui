import { servesRequests } from '@llama-webui/shared';
import { useEffect, useState } from 'react';
import { getServerProps, isExternalLoaded, propsRetry, type ServerProps } from '@/lib/props';
import { useServer } from '@/lib/server';

export type { ServerProps };

/**
 * /props of the server that takes requests (reread when the running process changes, and once an external server found
 * while it loaded says it is loaded), otherwise null.
 */
export function useServerProps(): ServerProps | null {
  const kind = useServer((s) => s.view?.state.kind);
  const serving = useServer((s) => servesRequests(s.view?.state));
  const pid = useServer((s) => (s.view && 'pid' in s.view.state ? s.view.state.pid : null));
  // One group for ready, sleeping and waking up: the same process, its /props are not reread on a sleep or a wake-up
  const liveGroup = !serving ? null : kind === 'external' ? 'external' : 'managed';
  const [props, setProps] = useState<ServerProps | null>(null);
  // Out of those states, no props: cleared by the render that leaves it, before the effect of the next state
  if (liveGroup === null && props !== null) setProps(null);
  const loaded = useServer((s) => isExternalLoaded(s.view?.state));
  const [retry, setRetry] = useState({ loaded, n: 0 });
  const nextRetry = propsRetry(retry, { loaded, missing: props === null });
  if (nextRetry !== retry) setRetry(nextRetry);
  useEffect(() => {
    if (liveGroup === null) return;
    let live = true;
    getServerProps().then(
      (p) => live && setProps(p),
      () => live && setProps(null),
    );
    return () => {
      live = false;
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- pid and retry.n are triggers: /props is reread on every server restart, and when an external server ends the load it was found in
  }, [liveGroup, pid, retry.n]);
  return props;
}
