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
  nvml: Schema.Boolean.annotate({
    description: 'Read NVIDIA GPUs through libnvidia-ml (NVML) instead of nvidia-smi. Requires restart.',
  }).pipe(Schema.withDecodingDefaultKey(Effect.succeed(true))),
  system: Schema.Boolean.annotate({ description: 'Collect CPU, RAM, load average and DRAM bandwidth samples.' }).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(true)),
  ),
  disk: Schema.Boolean.annotate({ description: 'Collect per-disk and model disk read/write throughput.' }).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(true)),
  ),
}).annotate({
  identifier: 'CollectorsConfig',
  description: 'Enabled hardware telemetry collectors.',
  message: 'Expected object',
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
  onboardingDone: false,
  collectors: { nvml: true, system: true, disk: true },
  theme: 'system' as typeof Theme.Type,
  env: {},
} as const;

/** The settings of llama-webui, stored key by key; a missing key takes its default. */
export const Settings = Schema.Struct({
  binary: Required.annotate({
    description: 'Path or command name of the llama-server binary (default: "llama-server").',
  }).pipe(Schema.withDecodingDefaultKey(Effect.succeed(DEFAULTS.binary))),
  host: Required.annotate({
    description: 'Default --host for llama-server when a profile does not set one (default: "127.0.0.1").',
  }).pipe(Schema.withDecodingDefaultKey(Effect.succeed(DEFAULTS.host))),
  port: IntBetween(1, 65535, 'Port between 1 and 65535')
    .annotate({
      description: 'Default --port for llama-server and external server detection (1–65535, default: 8080).',
    })
    .pipe(Schema.withDecodingDefaultKey(Effect.succeed(DEFAULTS.port))),
  modelsDir: Required.annotate({
    description: 'Root folder scanned for GGUF models (~ expanded, default: "~/models").',
  }).pipe(Schema.withDecodingDefaultKey(Effect.succeed(DEFAULTS.modelsDir))),
  pollIntervalMs: IntBetween(250, 60_000, 'Between 250 and 60000 ms')
    .annotate({ description: 'Monitoring polling interval in milliseconds (250–60000, default: 1000).' })
    .pipe(Schema.withDecodingDefaultKey(Effect.succeed(DEFAULTS.pollIntervalMs))),
  historySeconds: IntBetween(30, 1800, 'Between 30 and 1800 s')
    .annotate({ description: 'In-memory monitoring history window in seconds (30–1800, default: 300).' })
    .pipe(Schema.withDecodingDefaultKey(Effect.succeed(DEFAULTS.historySeconds))),
  /** Bus ids of the GPUs that are not read. */
  hiddenGpus: Schema.Array(Schema.String)
    .annotate({ description: 'PCI bus IDs of GPUs excluded from monitoring reads.' })
    .pipe(Schema.withDecodingDefaultKey(Effect.succeed(DEFAULTS.hiddenGpus))),
  defaultProfileId: Schema.NullOr(Schema.Int)
    .annotate({ description: 'Profile ID pre-selected on the Launchpad, or null.' })
    .pipe(Schema.withDecodingDefaultKey(Effect.succeed(DEFAULTS.defaultProfileId))),
  onboardingDone: Schema.Boolean.annotate({
    description: 'Whether the first-run setup checklist has been dismissed.',
  }).pipe(Schema.withDecodingDefaultKey(Effect.succeed(DEFAULTS.onboardingDone))),
  collectors: Collectors.pipe(Schema.withDecodingDefaultKey(Effect.succeed({}))),
  theme: Theme.annotate({ description: 'UI color scheme: system, light or dark.' }).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(DEFAULTS.theme)),
  ),
  env: Env.annotate({
    description: 'Global environment variables passed to every launched llama-server and llama-bench process.',
  }).pipe(Schema.withDecodingDefaultKey(Effect.succeed(DEFAULTS.env))),
}).annotate({
  identifier: 'Settings',
  description:
    'Application settings persisted in SQLite. Changes apply immediately except collectors.nvml, which requires restarting llama-webui.',
  message: 'Expected object',
});
export type Settings = typeof Settings.Type;
export type ThemeMode = Settings['theme'];

/** The settings of a new data directory. */
export const DEFAULT_SETTINGS: Settings = DEFAULTS;
