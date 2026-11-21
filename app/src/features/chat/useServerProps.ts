import { useEffect, useState } from 'react';
import { getServerProps, type ServerProps, serverPropsOf } from '@/lib/props';
import { useServer } from '@/lib/server';

export type { ServerProps };

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
    getServerProps().then(
      (p) => live && setProps(serverPropsOf(p)),
      () => live && setProps(null),
    );
    return () => {
      live = false;
    };
  }, [kind, pid]);
  return props;
}
