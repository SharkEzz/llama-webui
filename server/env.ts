import { readFileSync } from 'node:fs';
import { setGlobalProxyFromEnv } from 'node:http';
import { parseEnv } from 'node:util';

/** Lets `.env` override the environment: `1` or `true`, set in the environment or in the file itself. */
export const ENV_OVERRIDE = 'LLAMA_WEBUI_ENV_OVERRIDE';

/** The `--env-override` flag, read from the arguments before they are parsed (the `.env` comes first). */
export const overrideFlag = (argv = process.argv.slice(2)) => argv.includes('--env-override');

const enabled = (v: string | undefined) => v === '1' || v?.toLowerCase() === 'true';

/**
 * Loads `.env` (in the working directory by default) into `process.env`. Its variables fill what the environment
 * lacks; with `override` (`--env-override`) or `LLAMA_WEBUI_ENV_OVERRIDE` on, they also replace those already set. No file, nothing to do. Called by
 * the entry points (`server/dev.ts`, `server/main.ts`).
 */
export function loadDotEnv(path = '.env', o: { override?: boolean } = {}): void {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  const vars = parseEnv(text);
  const override = o.override || enabled(process.env[ENV_OVERRIDE] ?? vars[ENV_OVERRIDE]);
  for (const [key, value] of Object.entries(vars))
    if (override || process.env[key] === undefined) process.env[key] = value;
}

const PROXY_KEYS = ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy'] as const;
/** Never proxied: llama-server is reached on loopback, and a proxy would look for it on its own machine. */
const LOOPBACK = ['localhost', '127.0.0.1', '::1'];

/**
 * Sends outgoing requests (Hugging Face: search, repos, downloads) through `HTTP_PROXY`/`HTTPS_PROXY` when one is
 * set, minus the hosts of `NO_PROXY` and loopback: Node's `fetch` ignores those variables unless it is started with
 * `--use-env-proxy` or `NODE_USE_ENV_PROXY=1`, which a `.env` cannot set. Called by the entry points after
 * `loadDotEnv`. Returns what undoes it (tests), null when no proxy is set.
 */
export function useEnvProxy(env: Record<string, string | undefined> = process.env): (() => void) | null {
  const proxies = Object.fromEntries(PROXY_KEYS.flatMap((k) => (env[k] ? [[k, env[k]]] : [])));
  if (Object.keys(proxies).length === 0) return null;
  const none = [env.no_proxy ?? env.NO_PROXY, ...LOOPBACK].filter(Boolean).join(',');
  return setGlobalProxyFromEnv({ ...proxies, no_proxy: none, NO_PROXY: none });
}
