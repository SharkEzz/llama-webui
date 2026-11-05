import { type Flag, type FlagCatalog, parseHelp } from "@llama-webui/shared";

/** The catalogue of `binary`; null when it cannot run, fails, or lists no flag. */
export async function loadFlags(binary: string, timeoutMs = 5000): Promise<FlagCatalog | null> {
  try {
    const proc = Bun.spawn([binary, "--help"], { stdout: "pipe", stderr: "ignore", stdin: "ignore", timeout: timeoutMs });
    const [text, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    if (code !== 0) return null;
    const catalog = parseHelp(text);
    return catalog.flags.length > 0 ? catalog : null;
  } catch {
    return null;
  }
}

const cache = new Map<string, Promise<Flag[] | null>>();

/** Les flags de `binary`, lus une fois par binaire ; un échec n'est pas mis en cache. */
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
