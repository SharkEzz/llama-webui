import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Répertoire des données locales : `dir` (flag --data-dir), sinon $LLAMA_WEBUI_DATA_DIR, sinon
 * $XDG_DATA_HOME/llama-webui, sinon ~/.local/share/llama-webui. Créé si absent.
 */
export function dataDir(dir?: string): string {
  const resolved =
    dir ||
    process.env.LLAMA_WEBUI_DATA_DIR ||
    join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'llama-webui');
  mkdirSync(resolved, { recursive: true });
  return resolved;
}

export function dbPath(dir?: string): string {
  return join(dataDir(dir), 'llama-webui.sqlite');
}
