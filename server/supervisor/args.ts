import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { type Profile, type ProfileInput, type Settings, shellQuote } from '@llama-webui/shared';

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
    settings.binary,
    '-m',
    expandHome(profile.model, home),
    ...(profile.mmproj ? ['-mm', expandHome(profile.mmproj, home)] : []),
    ...profile.args,
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
