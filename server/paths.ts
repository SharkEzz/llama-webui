import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Répertoire des données locales : $LLAMA_WEBUI_DATA_DIR, sinon $XDG_DATA_HOME/llama-webui, sinon ~/.local/share/llama-webui. Créé si absent. */
export function dataDir(): string {
  const dir =
    process.env.LLAMA_WEBUI_DATA_DIR ||
    join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "llama-webui");
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function dbPath(): string {
  return join(dataDir(), "llama-webui.sqlite");
}
