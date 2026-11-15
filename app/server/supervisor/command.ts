import { LAUNCH_LOG_PREFIX, P2P_LOG_LINE, type Profile, type Settings, shellQuote } from '@llama-webui/shared';
import { Array as Arr, Config, Effect, Option, Path, Predicate, Record, String as Str } from 'effect';
import { homeDir } from '../config/Home.ts';

/** What the supervisor runs for a profile, and what it tells about it. */
export interface BuiltCommand {
  /** `setpriv --pdeathsig KILL --`, then the server's command: llama-server dies with llama-webui. */
  readonly argv: ReadonlyArray<string>;
  /** The server's command, shell-quoted, without the `setpriv` prefix. */
  readonly display: string;
  readonly cwd: string;
  /** The settings' variables, then the profile's: what is laid over llama-webui's own environment. */
  readonly env: Readonly<Record<string, string>>;
  /** `GGML_CUDA_P2P` is set, in `env` or in llama-webui's environment. */
  readonly p2p: boolean;
  readonly host: string;
  readonly port: number;
  readonly profileName: string;
  readonly profileId: number;
}

/** Flags that set llama-server's log verbosity; with none, the command adds `-lv 4`. */
const VERBOSITY_FLAGS = ['-lv', '--verbosity', '--log-verbosity', '-v', '--verbose', '--log-verbose'];

/**
 * The verbosity llama-webui runs llama-server at: 4 is the first level that logs the buffer sizes (model, KV, compute)
 * the Topology page reads. A profile that sets its own (a flag above, or `LLAMA_ARG_LOG_VERBOSITY` in its environment
 * or the global one of the settings) keeps it.
 */
const DEFAULT_VERBOSITY = '4';

const P2P_VARIABLE = 'GGML_CUDA_P2P';

const flagName = (arg: string): string => Arr.headNonEmpty(Str.split(arg, '='));

const setsVerbosity = (args: ReadonlyArray<string>, env: Readonly<Record<string, string>>): boolean =>
  Arr.some(args, (arg) => Arr.contains(VERBOSITY_FLAGS, flagName(arg))) || Record.has(env, 'LLAMA_ARG_LOG_VERBOSITY');

/** `~` and `~/…` expanded to `home`; any other path as it is. */
const expandHome = (path: Path.Path, home: string, file: string): string =>
  file === '~' ? home : Str.startsWith('~/')(file) ? path.join(home, Str.slice(2)(file)) : file;

/**
 * The files a profile opens, as llama-server will see them: `~` expanded everywhere, the model and the projector
 * resolved from the profile's folder, which defaults to `cwd` (llama-webui's own).
 */
export const profilePaths = (options: {
  readonly profile: Pick<Profile, 'model' | 'mmproj' | 'cwd'>;
  readonly home: string;
  readonly cwd: string;
  readonly path: Path.Path;
}): { readonly cwd: string; readonly model: string; readonly mmproj: string | null } => {
  const { profile, home, path } = options;
  const cwd =
    Predicate.isUndefined(profile.cwd) || Str.isEmpty(profile.cwd) ? options.cwd : expandHome(path, home, profile.cwd);
  const resolved = (file: string) => path.resolve(cwd, expandHome(path, home, file));
  return {
    cwd,
    model: resolved(profile.model),
    mmproj: Predicate.isUndefined(profile.mmproj) || Str.isEmpty(profile.mmproj) ? null : resolved(profile.mmproj),
  };
};

/**
 * The command of a profile under these settings. llama-server runs without a shell: `~` is expanded here (in the
 * binary, the model and the projector), relative paths stay relative to its folder.
 */
export const commandOf = (options: {
  readonly profile: Profile;
  readonly settings: Pick<Settings, 'binary' | 'host' | 'port' | 'env'>;
  readonly home: string;
  readonly cwd: string;
  readonly p2pInEnvironment: boolean;
  readonly path: Path.Path;
}): BuiltCommand => {
  const { profile, settings, home, path } = options;
  const host = profile.host ?? settings.host;
  const port = profile.port ?? settings.port;
  // The settings' variables, then the profile's: a profile variable with the same name wins.
  const env = { ...settings.env, ...profile.env };
  const mmproj =
    Predicate.isUndefined(profile.mmproj) || Str.isEmpty(profile.mmproj)
      ? []
      : ['-mm', expandHome(path, home, profile.mmproj)];
  const server = [
    expandHome(path, home, settings.binary),
    '-m',
    expandHome(path, home, profile.model),
    ...mmproj,
    ...profile.args,
    ...(setsVerbosity(profile.args, env) ? [] : ['-lv', DEFAULT_VERBOSITY]),
    '--host',
    host,
    '--port',
    `${port}`,
    '--metrics',
    '--slots',
    '--props',
  ];
  return {
    argv: ['setpriv', '--pdeathsig', 'KILL', '--', ...server],
    display: shellQuote(server),
    cwd: profilePaths({ profile, home, cwd: options.cwd, path }).cwd,
    env,
    p2p: Record.has(env, P2P_VARIABLE) || options.p2pInEnvironment,
    host,
    port,
    profileName: profile.name,
    profileId: profile.id,
  };
};

/**
 * The command of a profile, with the home folder, llama-webui's working directory, and whether `GGML_CUDA_P2P` is in
 * llama-webui's environment (read through `Config`, where an empty value reads as absent).
 */
export const buildCommand = Effect.fn('command.buildCommand')(function* (options: {
  readonly profile: Profile;
  readonly settings: Settings;
}) {
  const path = yield* Path.Path;
  const home = yield* homeDir;
  const p2p = yield* Config.option(Config.String(P2P_VARIABLE)).pipe(Effect.orElseSucceed(Option.none<string>));
  const cwd = path.resolve('.');
  return commandOf({ ...options, home, cwd, p2pInEnvironment: Option.isSome(p2p), path });
});

/**
 * The lines llama-webui writes to the log ring when it launches llama-server: the command, then what the Topology page
 * cannot read from llama-server's own output. llama.cpp enables CUDA peer-to-peer as soon as `GGML_CUDA_P2P` exists,
 * whatever its value, and logs nothing about it.
 */
export const launchLines = (cmd: Pick<BuiltCommand, 'display' | 'p2p'>): ReadonlyArray<string> => [
  `${LAUNCH_LOG_PREFIX} ${cmd.display}`,
  ...(cmd.p2p ? [P2P_LOG_LINE] : []),
];
