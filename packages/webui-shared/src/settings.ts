import { Array as Arr, Effect, Record as Rec, Schema } from 'effect';

/** A shell environment variable name. */
export const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** A non-empty string. */
const Required = Schema.String.check(Schema.isMinLength(1, { message: 'Required' }));

/** An integer in `[minimum, maximum]`, with the message of its bound. */
const IntBetween = (minimum: number, maximum: number, message: string) =>
  Schema.Number.annotate({ message: 'Expected a number' }).check(
    Schema.isFinite({ message: 'Expected a number' }),
    Schema.isInt({ message: 'Expected an integer' }),
    Schema.isBetween({ minimum, maximum }, { message }),
  );

/** Variables added to the environment of what llama-webui starts; each name is a shell name. */
const Env = Schema.Record(Schema.String, Schema.String).check(
  Schema.makeFilter((env) =>
    Arr.flatMap(Rec.keys(env), (name) =>
      ENV_NAME.test(name) ? [] : [{ path: [name], issue: `invalid variable name “${name}”` }],
    ),
  ),
);

const Collectors = Schema.Struct({
  nvml: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(true))),
  system: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(true))),
  disk: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(true))),
});

const Theme = Schema.Literals(['system', 'light', 'dark']);

/** The defaults, those of the Nitro server; each field of `Settings` takes its own when the key is missing. */
const DEFAULTS = {
  binary: 'llama-server',
  // llama-server listens on loopback by default, like llama-webui (#27).
  host: '127.0.0.1',
  port: 8080,
  modelsDir: '~/models',
  pollIntervalMs: 1000,
  historySeconds: 300,
  hiddenGpus: [] as ReadonlyArray<string>,
  defaultProfileId: null,
  llamaTuiImportDismissed: false,
  onboardingDone: false,
  collectors: { nvml: true, system: true, disk: true },
  theme: 'system' as typeof Theme.Type,
  env: {},
} as const;

/** The settings of llama-webui, stored key by key; a missing key takes its default. */
export const Settings = Schema.Struct({
  binary: Required.pipe(Schema.withDecodingDefaultKey(Effect.succeed(DEFAULTS.binary))),
  host: Required.pipe(Schema.withDecodingDefaultKey(Effect.succeed(DEFAULTS.host))),
  port: IntBetween(1, 65535, 'Port between 1 and 65535').pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(DEFAULTS.port)),
  ),
  modelsDir: Required.pipe(Schema.withDecodingDefaultKey(Effect.succeed(DEFAULTS.modelsDir))),
  pollIntervalMs: IntBetween(250, 60_000, 'Between 250 and 60000 ms').pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(DEFAULTS.pollIntervalMs)),
  ),
  historySeconds: IntBetween(30, 1800, 'Between 30 and 1800 s').pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(DEFAULTS.historySeconds)),
  ),
  /** Bus ids of the GPUs that are not read. */
  hiddenGpus: Schema.Array(Schema.String).pipe(Schema.withDecodingDefaultKey(Effect.succeed(DEFAULTS.hiddenGpus))),
  defaultProfileId: Schema.NullOr(Schema.Int).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(DEFAULTS.defaultProfileId)),
  ),
  llamaTuiImportDismissed: Schema.Boolean.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(DEFAULTS.llamaTuiImportDismissed)),
  ),
  onboardingDone: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(DEFAULTS.onboardingDone))),
  collectors: Collectors.pipe(Schema.withDecodingDefaultKey(Effect.succeed({}))),
  theme: Theme.pipe(Schema.withDecodingDefaultKey(Effect.succeed(DEFAULTS.theme))),
  env: Env.pipe(Schema.withDecodingDefaultKey(Effect.succeed(DEFAULTS.env))),
});
export type Settings = typeof Settings.Type;
export type ThemeMode = Settings['theme'];

/** The settings of a new data directory. */
export const DEFAULT_SETTINGS: Settings = DEFAULTS;
