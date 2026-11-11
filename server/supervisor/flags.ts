import type { Flag } from '@llama-webui/shared';
import { loadFlags } from 'llamacpp-js/node';

const cache = new Map<string, Promise<Flag[] | null>>();

/** The flags of `binary`, read once per binary; a failure is not cached. */
export function getFlags(binary: string): Promise<Flag[] | null> {
  let p = cache.get(binary);
  if (!p) {
    p = loadFlags(binary).then((c) => {
      if (!c) cache.delete(binary);
      return c?.flags ?? null;
    });
    cache.set(binary, p);
  }
  return p;
}
