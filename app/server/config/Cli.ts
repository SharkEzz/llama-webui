import { Array as Arr, Effect, type Option, Schema, String as Str } from 'effect';
import { CliConfig, type CliError, Command, Flag, GlobalFlag } from 'effect/cli';
import { VERSION } from './AppInfo.ts';

/** The options of the command line. A flag left out is `none`: its variable, then its default, apply (`AppConfig`). */
export interface CliFlags {
  /** `--host`, non-empty. */
  readonly host: Option.Option<string>;
  /** `--port`, an integer from 1 to 65535. */
  readonly port: Option.Option<number>;
  /** `--data-dir`, non-empty. */
  readonly dataDir: Option.Option<string>;
  /** `--env-override`: `.env` replaces the variables the environment already sets. */
  readonly envOverride: boolean;
}

const Port = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 }));

const flags = {
  host: Flag.String('host').pipe(
    Flag.withSchema(Schema.NonEmptyString),
    Flag.withMetavar('address'),
    Flag.withDescription(
      'listen address (default: 127.0.0.1); 0.0.0.0 to open it to the local network (no authentication). env: LLAMA_WEBUI_HOST',
    ),
    Flag.optional,
  ),
  port: Flag.Int('port').pipe(
    Flag.withSchema(Port),
    Flag.withMetavar('port'),
    Flag.withDescription('HTTP port of the UI, API and WebSocket (default: 7860). env: LLAMA_WEBUI_PORT'),
    Flag.optional,
  ),
  dataDir: Flag.String('data-dir').pipe(
    Flag.withSchema(Schema.NonEmptyString),
    Flag.withMetavar('path'),
    Flag.withDescription(
      'data directory (SQLite database); default: $XDG_DATA_HOME/llama-webui, else ~/.local/share/llama-webui. env: LLAMA_WEBUI_DATA_DIR',
    ),
    Flag.optional,
  ),
  envOverride: Flag.Boolean('env-override').pipe(
    Flag.withDescription(
      'let .env (working directory, loaded at startup) replace the variables the environment already sets; without it, .env only fills those it does not set. env: LLAMA_WEBUI_ENV_OVERRIDE=1 (in the environment or in .env)',
    ),
    Flag.withDefault(false),
  ),
};

/** What `--help` says above the usage and the flags: how to run it, and the variables that are not flags. */
const LINES = [
  'llama-webui: web UI to drive llama-server (API, WebSocket and UI in a single Node.js process).',
  '',
  'Ways of running:',
  '  llama-webui [options]   installed package (npm install -g llama-webui-<version>.tgz)',
  '  pnpm start [options]    production (builds, then runs app/.output/llama-webui.mjs), from the repository',
  '  pnpm dev                development (vite dev), from the repository: no options, the LLAMA_WEBUI_* variables',
  '                          of the environment or of app/.env instead',
  '',
  'A flag takes precedence over the matching environment variable.',
  '',
  'Hugging Face downloads (Models page):',
  '  HF_TOKEN               access token (gated or private repos, higher rate limits); without it, the token',
  '                         saved by `hf auth login` is used (HF_TOKEN_PATH, else $HF_HOME/token,',
  '                         default ~/.cache/huggingface/token)',
  '  HF_ENDPOINT            Hugging Face endpoint or mirror (default: https://huggingface.co)',
  '  HTTPS_PROXY, HTTP_PROXY, NO_PROXY',
  '                         proxy for the requests to Hugging Face; localhost and loopback addresses are',
  '                         never proxied',
];

/** The formatter indents the first line of the description only: the others get the same two spaces here. */
const DESCRIPTION = Arr.join(
  Arr.map(LINES, (line, i) => (i === 0 || line === '' ? line : `  ${line}`)),
  '\n',
);

const command = <E, R>(start: (flags: CliFlags) => Effect.Effect<void, E, R>) =>
  Command.make('llama-webui', flags, start).pipe(Command.withDescription(DESCRIPTION));

/** `--version` prints `llama-webui v<version>`: without the `v` of a git tag. */
const version = Str.startsWith('v')(VERSION) ? Str.slice(1)(VERSION) : VERSION;

/** Of the built-in flags, `--help`/`-h` and `--version`/`-v` only. */
const config = CliConfig.make({ builtIns: [GlobalFlag.Help, GlobalFlag.Version] });

/**
 * The `llama-webui` command on the arguments of the process: parses them, then runs `start` with the flags.
 * `--help`/`-h` and `--version` print and end; a usage error prints the help, then the error, and fails.
 */
export const cli = <E, R>(
  start: (flags: CliFlags) => Effect.Effect<void, E, R>,
): Effect.Effect<void, E | CliError.CliError, R | Command.Environment> =>
  Command.run(command(start), { version }).pipe(Effect.provideService(CliConfig.CliConfig, config));

/** The same on given arguments (tests). */
export const cliWith =
  <E, R>(start: (flags: CliFlags) => Effect.Effect<void, E, R>) =>
  (args: ReadonlyArray<string>): Effect.Effect<void, E | CliError.CliError, R | Command.Environment> =>
    Command.runWith(command(start), { version })(args).pipe(Effect.provideService(CliConfig.CliConfig, config));
