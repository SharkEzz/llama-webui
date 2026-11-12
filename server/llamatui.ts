import { homedir } from 'node:os';
import { join } from 'node:path';
import { type ProfileImport, parseProfileImport } from '@llama-webui/shared';
import { fileExists, readText } from './proc';

/** Path of the llama-tui config (same rule as llama-tui). */
export function llamaTuiConfigPath(env: Record<string, string | undefined> = process.env): string {
  const base = env.XDG_CONFIG_HOME || join(env.HOME || homedir(), '.config');
  return join(base, 'llama-tui', 'config.json');
}

export interface LlamaTuiConfig extends ProfileImport {
  path: string;
  exists: boolean;
  defaultProfile: string | null;
  error?: string;
}

/** Profiles from the llama-tui config; missing file → `exists: false`, unreadable JSON → `error`. */
export async function readLlamaTuiProfiles(path = llamaTuiConfigPath()): Promise<LlamaTuiConfig> {
  const empty = { path, profiles: [], rejected: [], defaultProfile: null };
  if (!(await fileExists(path))) return { ...empty, exists: false };
  let raw: unknown;
  try {
    raw = JSON.parse(await readText(path));
  } catch (e) {
    return { ...empty, exists: true, error: `Invalid JSON: ${(e as Error).message}` };
  }
  const defaultProfile =
    typeof raw === 'object' && raw !== null && 'defaultProfile' in raw && typeof raw.defaultProfile === 'string'
      ? raw.defaultProfile
      : null;
  return { path, exists: true, defaultProfile, ...parseProfileImport(raw) };
}
