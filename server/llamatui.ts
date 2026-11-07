import { homedir } from "node:os";
import { join } from "node:path";
import { type ProfileImport, parseProfileImport } from "@llama-webui/shared";

/** Chemin de la config llama-tui (même règle que llama-tui). */
export function llamaTuiConfigPath(env: Record<string, string | undefined> = process.env): string {
  const base = env.XDG_CONFIG_HOME || join(env.HOME || homedir(), ".config");
  return join(base, "llama-tui", "config.json");
}

export interface LlamaTuiConfig extends ProfileImport {
  path: string;
  exists: boolean;
  defaultProfile: string | null;
  error?: string;
}

/** Profils de la config llama-tui ; fichier absent → `exists: false`, JSON illisible → `error`. */
export async function readLlamaTuiProfiles(path = llamaTuiConfigPath()): Promise<LlamaTuiConfig> {
  const file = Bun.file(path);
  const empty = { path, profiles: [], rejected: [], defaultProfile: null };
  if (!(await file.exists())) return { ...empty, exists: false };
  let raw: unknown;
  try {
    raw = JSON.parse(await file.text());
  } catch (e) {
    return { ...empty, exists: true, error: `JSON invalide : ${(e as Error).message}` };
  }
  const defaultProfile =
    typeof raw === "object" && raw !== null && "defaultProfile" in raw && typeof raw.defaultProfile === "string"
      ? raw.defaultProfile
      : null;
  return { path, exists: true, defaultProfile, ...parseProfileImport(raw) };
}
