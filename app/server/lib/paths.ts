import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Local data directory: `dir` (--data-dir flag), else $LLAMA_WEBUI_DATA_DIR, else
 * $XDG_DATA_HOME/llama-webui, else ~/.local/share/llama-webui. Created if missing.
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
