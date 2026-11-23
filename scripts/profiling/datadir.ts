// The data directory of a `--base` run: each side works on its own copy, made before the first measure and removed by
// the run's undo. Both sides then start from the same data, and the migrations of a branch never reach the real one.
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseEnv } from 'node:util';
import type { RunDir } from './run-dir.ts';
import { REPO } from './target.ts';

const set = (value: string | undefined): value is string => value !== undefined && value !== '';
const enabled = (value: string | undefined) => value === '1' || value?.toLowerCase() === 'true';

/**
 * The data directory the server started by the tool would use, by the server's own rules (`app/server/config/`):
 * `--data-dir`, else `LLAMA_WEBUI_DATA_DIR`, else `$XDG_DATA_HOME/llama-webui`, else `~/.local/share/llama-webui`. A
 * variable comes from the environment, else from the `.env` of the server's working directory (`dotEnv`, its text);
 * the file wins with `LLAMA_WEBUI_ENV_OVERRIDE=1|true` in either. An empty variable counts as unset.
 */
export function sourceDataDir(
  dataDir: string | null,
  env: NodeJS.ProcessEnv,
  dotEnv: string | null,
  cwd: string,
  systemHome: string,
): string {
  if (dataDir !== null) return resolve(cwd, dataDir);
  const file = dotEnv === null ? {} : parseEnv(dotEnv);
  const override = enabled(env.LLAMA_WEBUI_ENV_OVERRIDE ?? file.LLAMA_WEBUI_ENV_OVERRIDE);
  const read = (key: string): string | undefined => {
    const [first, second] = override ? [file[key], env[key]] : [env[key], file[key]];
    // `.env` fills what the environment does not define, an empty value included.
    const value = first ?? second;
    return set(value) ? value : undefined;
  };
  const given = read('LLAMA_WEBUI_DATA_DIR');
  if (given !== undefined) return resolve(cwd, given);
  const dataHome = read('XDG_DATA_HOME') ?? join(read('HOME') ?? systemHome, '.local', 'share');
  return resolve(cwd, dataHome, 'llama-webui');
}

/** The data directory a run started from the repository would use. */
export function repoDataDir(dataDir: string | null): string {
  const file = join(REPO, '.env');
  return sourceDataDir(dataDir, process.env, existsSync(file) ? readFileSync(file, 'utf8') : null, REPO, homedir());
}

/** Where a run keeps its copy of the data directory. */
export const dataCopyOf = (run: RunDir): string => run.file('datadir');

/**
 * Copies `source` into the run (an empty folder when there is none yet) and returns the copy. Written to the run's
 * state first: the undo removes it, with the profiles, conversations and settings it holds.
 */
export function copyDataDir(run: RunDir, source: string): string {
  const copy = dataCopyOf(run);
  run.writeState({ ...run.readState(), dataCopy: true });
  if (existsSync(source)) cpSync(source, copy, { recursive: true });
  else mkdirSync(copy, { recursive: true });
  return copy;
}

export function removeDataCopy(run: RunDir): void {
  rmSync(dataCopyOf(run), { recursive: true, force: true });
}
