import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  LAUNCH_LOG_PREFIX,
  P2P_LOG_LINE,
  type Profile,
  type ProfileInput,
  type Settings,
  shellQuote,
} from '@llama-webui/shared';

export interface BuiltCommand {
  argv: string[];
  display: string;
  cwd: string;
  env: Record<string, string>;
  host: string;
  port: number;
  profileName: string;
  profileId: number;
}

export function expandHome(p: string, home: string = homedir()): string {
  if (p === '~') return home;
  if (p.startsWith('~/')) return join(home, p.slice(2));
  return p;
}

/** The `binary` setting as a path to run: `~` expanded (a bare name stays bare, looked up in the PATH). */
export function binaryPath(settings: Pick<Settings, 'binary'>, home: string = homedir()): string {
  return expandHome(settings.binary, home);
}

/** Flags that set llama-server's log verbosity; with none, `buildCommand()` adds `-lv 4`. */
const VERBOSITY_FLAGS = new Set(['-lv', '--verbosity', '--log-verbosity', '-v', '--verbose', '--log-verbose']);

/**
 * Verbosity llama-webui runs llama-server at: 4 is the first level that logs the buffer sizes (model, KV, compute) the
 * Topology page reads. A profile that sets its own (a flag above, or `LLAMA_ARG_LOG_VERBOSITY` in its environment)
 * keeps it.
 */
export const DEFAULT_VERBOSITY = '4';

function setsVerbosity(profile: Pick<Profile, 'args' | 'env'>): boolean {
  if (profile.args.some((a) => VERBOSITY_FLAGS.has(a.split('=')[0]!))) return true;
  return 'LLAMA_ARG_LOG_VERBOSITY' in profile.env;
}

export interface ProfilePaths {
  /** Where llama-server runs: the profile's cwd (`~` expanded), else the app's. */
  cwd: string;
  /** The model file, absolute. */
  model: string;
  mmproj: string | null;
}

/** The files a profile opens, as llama-server will see them: `~` expanded, relative paths taken from its cwd. */
export function profilePaths(profile: ProfileInput, home: string = homedir()): ProfilePaths {
  const cwd = profile.cwd ? expandHome(profile.cwd, home) : process.cwd();
  return {
    cwd,
    model: resolve(cwd, expandHome(profile.model, home)),
    mmproj: profile.mmproj ? resolve(cwd, expandHome(profile.mmproj, home)) : null,
  };
}

export function buildCommand(
  profile: Profile,
  settings: Pick<Settings, 'binary' | 'host' | 'port'>,
  home: string = homedir(),
): BuiltCommand {
  const host = profile.host ?? settings.host;
  const port = profile.port ?? settings.port;
  // llama-server runs without a shell: `~` is expanded here, relative paths stay relative to its cwd.
  const server = [
    binaryPath(settings, home),
    '-m',
    expandHome(profile.model, home),
    ...(profile.mmproj ? ['-mm', expandHome(profile.mmproj, home)] : []),
    ...profile.args,
    ...(setsVerbosity(profile) ? [] : ['-lv', DEFAULT_VERBOSITY]),
    '--host',
    host,
    '--port',
    String(port),
    '--metrics',
    '--slots',
    '--props',
  ];
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  Object.assign(env, profile.env);
  return {
    argv: ['setpriv', '--pdeathsig', 'KILL', '--', ...server],
    display: shellQuote(server),
    cwd: profilePaths(profile, home).cwd,
    env,
    host,
    port,
    profileName: profile.name,
    profileId: profile.id,
  };
}

/**
 * Lines llama-webui writes to the log ring when it launches llama-server: the command, then what the Topology page
 * cannot read from llama-server's own output. llama.cpp enables CUDA peer-to-peer as soon as `GGML_CUDA_P2P` exists,
 * whatever its value, and logs nothing about it.
 */
export function launchLines(cmd: Pick<BuiltCommand, 'display' | 'env'>): string[] {
  return [`${LAUNCH_LOG_PREFIX} ${cmd.display}`, ...('GGML_CUDA_P2P' in cmd.env ? [P2P_LOG_LINE] : [])];
}
