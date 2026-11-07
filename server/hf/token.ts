import { homedir } from 'node:os';
import { join } from 'node:path';
import type { HfTokenSource } from '@llama-webui/shared';

export type Env = Record<string, string | undefined>;

export interface HfToken {
  token: string | null;
  source: HfTokenSource;
}

const DEFAULT_ENDPOINT = 'https://huggingface.co';

/** Hugging Face endpoint: `HF_ENDPOINT` (mirror), else huggingface.co; without a trailing slash. */
export const hfEndpoint = (env: Env = process.env) => (env.HF_ENDPOINT?.trim() || DEFAULT_ENDPOINT).replace(/\/+$/, '');

/** Where `hf auth login` writes the token: `HF_TOKEN_PATH`, else `$HF_HOME/token` (default `~/.cache/huggingface`). */
export function hfTokenPath(env: Env = process.env, home = homedir()): string {
  if (env.HF_TOKEN_PATH) return env.HF_TOKEN_PATH;
  const hfHome = env.HF_HOME || join(env.XDG_CACHE_HOME || join(home, '.cache'), 'huggingface');
  return join(hfHome, 'token');
}

/**
 * The Hugging Face token, same rules as the `hf` CLI: `HF_TOKEN` (or the legacy `HUGGING_FACE_HUB_TOKEN`), else
 * the token file. Read on every call, so an `hf auth login` done while llama-webui runs is picked up.
 */
export async function resolveHfToken(env: Env = process.env, home = homedir()): Promise<HfToken> {
  const fromEnv = (env.HF_TOKEN || env.HUGGING_FACE_HUB_TOKEN || '').trim();
  if (fromEnv) return { token: fromEnv, source: 'env' };
  const fromFile = await Bun.file(hfTokenPath(env, home))
    .text()
    .then((t) => t.trim())
    .catch(() => '');
  return fromFile ? { token: fromFile, source: 'file' } : { token: null, source: null };
}
