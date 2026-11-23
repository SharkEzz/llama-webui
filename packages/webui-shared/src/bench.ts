import { Array as Arr, Effect, Option, Predicate, Schema, String as Str } from 'effect';
import { dual } from 'effect/Function';
import type { BenchMeasure, BenchDevice as LlamaBenchDevice } from 'llamacpp-js/bench';
import { reservedFlag, reservedFlagMessage } from './profile.ts';
import type { FitVerdict } from './tuning.ts';

export const CACHE_TYPES = ['f32', 'f16', 'bf16', 'f8_e4m3', 'q8_0', 'q4_0', 'q4_1', 'iq4_nl', 'q5_0', 'q5_1'] as const;
export type CacheType = (typeof CACHE_TYPES)[number];
export const SPLIT_MODES = ['none', 'layer', 'row', 'tensor'] as const;
export const FLASH_ATTN = ['on', 'off', 'auto'] as const;

/** An integer between `min` and `max`; `message` replaces every one of its messages when given. */
const int = (min: number, max = 1_000_000, message?: string) =>
  Schema.Number.annotate({ message: message ?? 'expected a number' }).check(
    Schema.isFinite({ message: message ?? 'expected a number' }),
    Schema.isInt({ message: message ?? 'expected an integer' }),
    Schema.isGreaterThanOrEqualTo(min, { message: message ?? `at least ${min}` }),
    Schema.isLessThanOrEqualTo(max, { message: message ?? `at most ${max}` }),
  );

const nglMessage = 'a number, “all” or “auto”';
const Ngl = Schema.Union([int(0, 9999, nglMessage), Schema.Literal('all'), Schema.Literal('auto')]).annotate({
  message: nglMessage,
});
const Override = Schema.String.check(
  Schema.isPattern(/^[^=,;]+=[^=,;]+$/, { message: 'expected pattern=buffer (e.g. exps=CPU)' }),
);
const DeviceName = Schema.String.check(
  Schema.isPattern(/^[A-Za-z]+\d*$/, { message: 'expected a device name (e.g. CUDA0)' }),
);
const Proportion = Schema.Number.annotate({ message: 'expected a number' }).check(
  Schema.isFinite({ message: 'expected a number' }),
  Schema.isGreaterThanOrEqualTo(0, { message: 'expected a positive proportion' }),
);
const SplitMode = Schema.Literals(SPLIT_MODES).annotate({ message: 'none, layer, row or tensor' });
const FlashAttn = Schema.Literals(FLASH_ATTN).annotate({ message: 'on, off or auto' });
const Cache = Schema.Literals(CACHE_TYPES).annotate({ message: 'unknown cache type' });

/** The rules of each field, one schema per field: a sweep's space lists values of the same schemas. */
export const BENCH_FIELDS = {
  ngl: Ngl,
  ot: Schema.Array(Override),
  ncmoe: int(0, 9999),
  dev: Schema.Array(DeviceName),
  ts: Schema.Array(Proportion),
  sm: SplitMode,
  fa: FlashAttn,
  ctk: Cache,
  ctv: Cache,
  t: int(1, 1024),
  b: int(1),
  ub: int(1),
};

/**
 * The spec's flags, in a form shared by both tools, as a person writes them (strict: decoded with an unknown key
 * refused). Missing key = the tool's default.
 */
export const BenchParams = Schema.Struct({
  ngl: Schema.optionalKey(BENCH_FIELDS.ngl),
  ot: Schema.optionalKey(BENCH_FIELDS.ot),
  ncmoe: Schema.optionalKey(BENCH_FIELDS.ncmoe),
  dev: Schema.optionalKey(BENCH_FIELDS.dev),
  ts: Schema.optionalKey(BENCH_FIELDS.ts),
  sm: Schema.optionalKey(BENCH_FIELDS.sm),
  fa: Schema.optionalKey(BENCH_FIELDS.fa),
  ctk: Schema.optionalKey(BENCH_FIELDS.ctk),
  ctv: Schema.optionalKey(BENCH_FIELDS.ctv),
  t: Schema.optionalKey(BENCH_FIELDS.t),
  b: Schema.optionalKey(BENCH_FIELDS.b),
  ub: Schema.optionalKey(BENCH_FIELDS.ub),
}).annotate({ messageUnexpectedKey: 'unknown key' });
export type BenchParams = typeof BenchParams.Type;
type Key = keyof BenchParams;

/** The flags as they are stored: the fields of `BenchParams` without its rules (a reply carries what is stored). */
export const StoredBenchParams = Schema.Struct({
  ngl: Schema.optionalKey(Schema.Union([Schema.Finite, Schema.Literal('all'), Schema.Literal('auto')])),
  ot: Schema.optionalKey(Schema.Array(Schema.String)),
  ncmoe: Schema.optionalKey(Schema.Finite),
  dev: Schema.optionalKey(Schema.Array(Schema.String)),
  ts: Schema.optionalKey(Schema.Array(Schema.Finite)),
  sm: Schema.optionalKey(Schema.Literals(SPLIT_MODES)),
  fa: Schema.optionalKey(Schema.Literals(FLASH_ATTN)),
  ctk: Schema.optionalKey(Schema.Literals(CACHE_TYPES)),
  ctv: Schema.optionalKey(Schema.Literals(CACHE_TYPES)),
  t: Schema.optionalKey(Schema.Finite),
  b: Schema.optionalKey(Schema.Finite),
  ub: Schema.optionalKey(Schema.Finite),
}) satisfies Schema.Codec<BenchParams>;

interface Field {
  readonly key: Key;
  readonly short: string;
  readonly long: ReadonlyArray<string>;
}

/** Fixed field order, with each field's short flag and its llama-server long forms. */
const FIELDS: ReadonlyArray<Field> = [
  { key: 'ngl', short: '-ngl', long: ['--gpu-layers', '--n-gpu-layers'] },
  { key: 'ot', short: '-ot', long: ['--override-tensor'] },
  { key: 'ncmoe', short: '-ncmoe', long: ['--n-cpu-moe'] },
  { key: 'dev', short: '-dev', long: ['--device'] },
  { key: 'ts', short: '-ts', long: ['--tensor-split'] },
  { key: 'sm', short: '-sm', long: ['--split-mode'] },
  { key: 'fa', short: '-fa', long: ['--flash-attn'] },
  { key: 'ctk', short: '-ctk', long: ['--cache-type-k'] },
  { key: 'ctv', short: '-ctv', long: ['--cache-type-v'] },
  { key: 't', short: '-t', long: ['--threads'] },
  { key: 'b', short: '-b', long: ['--batch-size'] },
  { key: 'ub', short: '-ub', long: ['--ubatch-size'] },
];
/** Fixed field order (translation, cartesian product of a sweep, labels). */
export const FIELD_ORDER: ReadonlyArray<Key> = Arr.map(FIELDS, (f) => f.key);
const BY_FLAG = new Map(Arr.flatMap(FIELDS, (f) => Arr.map([f.short, ...f.long], (flag) => [flag, f] as const)));

export const BenchKind = Schema.Literals(['bench', 'server']);
export type BenchKind = typeof BenchKind.Type;
/** Prefix of the error recorded for a run that ran out of memory. */
export const OOM_ERROR = 'Out of memory';
/** Prefixes written by earlier versions, still present in existing databases. */
const LEGACY_OOM_ERRORS: ReadonlyArray<string> = ['Mémoire insuffisante'];
/** True when a run's error is an out-of-memory failure (current or legacy wording). */
export const isOomError = (error: string | null | undefined): boolean =>
  Predicate.isString(error) &&
  (Str.startsWith(OOM_ERROR)(error) || Arr.some(LEGACY_OOM_ERRORS, (prefix) => Str.startsWith(prefix)(error)));

/** `queued`: a sweep item waiting its turn. */
export const BenchStatus = Schema.Literals(['queued', 'running', 'ok', 'failed', 'cancelled', 'interrupted']);
export type BenchStatus = typeof BenchStatus.Type;

/** Why an argument of “Other server flags” is refused: a reserved flag, or a flag one of the fields covers. */
const serverArgIssue = (arg: string): Option.Option<string> => {
  const reserved = reservedFlag(arg);
  if (reserved !== undefined) return Option.some(reservedFlagMessage(reserved));
  const flag = Arr.headNonEmpty(Str.split(arg, '='));
  return Option.map(Option.fromUndefinedOr(BY_FLAG.get(flag)), (field) => `${flag}: use the ${field.short} field`);
};

/** “Other server flags”: rejects reserved flags and those covered by a field, at the offending index. */
export const serverArgsField = Schema.Array(Schema.String)
  .check(
    Schema.makeFilter((args) =>
      Arr.flatMap(args, (arg, index) =>
        Option.match(serverArgIssue(arg), { onNone: () => [], onSome: (issue) => [{ path: [index], issue }] }),
      ),
    ),
  )
  .pipe(Schema.withDecodingDefaultKey(Effect.succeed([])));

const ModelPath = Schema.String.annotate({ message: 'required' })
  .check(
    Schema.isStartingWith('/', { message: 'expected an absolute path' }),
    Schema.isEndingWith('.gguf', { message: 'expected a .gguf file' }),
  )
  .annotateKey({ messageMissingKey: 'required' });

/** Fields shared by a run and a sweep, as a person writes them. */
export const benchSpecBase = {
  modelPath: ModelPath,
  mmprojPath: Schema.NullOr(Schema.String).pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))),
  profileId: Schema.NullOr(Schema.Int).pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))),
  p: int(1, 32_768).pipe(Schema.withDecodingDefaultKey(Effect.succeed(512))),
  n: int(1, 4096).pipe(Schema.withDecodingDefaultKey(Effect.succeed(128))),
  r: int(1, 20).pipe(Schema.withDecodingDefaultKey(Effect.succeed(3))),
};

/** The same fields as they are stored, without their rules. */
export const storedSpecBase = {
  modelPath: Schema.String,
  mmprojPath: Schema.NullOr(Schema.String),
  profileId: Schema.NullOr(Schema.Int),
  p: Schema.Finite,
  n: Schema.Finite,
  r: Schema.Finite,
};

/** A run as a person asks for it (strict), its defaults applied. */
export const BenchSpec = Schema.Struct({
  kind: BenchKind.annotate({ message: '“bench” or “server”' }),
  ...benchSpecBase,
  params: BenchParams.pipe(Schema.withDecodingDefaultKey(Effect.succeed({}))),
  serverArgs: serverArgsField,
}).annotate({ messageUnexpectedKey: 'unknown key' });
export type BenchSpec = typeof BenchSpec.Type;
export type BenchSpecInput = typeof BenchSpec.Encoded;

/** A run's spec as it is stored: the fields of `BenchSpec` without its rules. */
export const StoredBenchSpec = Schema.Struct({
  kind: BenchKind,
  ...storedSpecBase,
  params: StoredBenchParams,
  serverArgs: Schema.Array(Schema.String),
}) satisfies Schema.Codec<BenchSpec>;

/** A pp or tg measure of a run. */
export const Measure = Schema.Struct({
  tps: Schema.Finite,
  stddev: Schema.Finite,
  tokens: Schema.Finite,
}) satisfies Schema.Codec<BenchMeasure>;
export type Measure = typeof Measure.Type;

/** The machine a run ran on, frozen at its start. */
export const BenchHardware = Schema.Struct({
  cpu: Schema.String,
  gpus: Schema.Array(Schema.Struct({ name: Schema.String, busId: Schema.String, vramTotalBytes: Schema.Finite })),
  build: Schema.NullOr(Schema.String),
});
export type BenchHardware = typeof BenchHardware.Type;

/** The estimator's verdict on a configuration (`FitVerdict` of `tuning.ts`). */
const Fit = Schema.Literals(['fits', 'tight', 'no']) satisfies Schema.Codec<FitVerdict>;

/** A benchmark run, one-off or an item of a sweep. */
export const BenchRun = Schema.Struct({
  id: Schema.Int,
  kind: BenchKind,
  status: BenchStatus,
  spec: StoredBenchSpec,
  command: Schema.String,
  hardware: BenchHardware,
  pp: Schema.NullOr(Measure),
  tg: Schema.NullOr(Measure),
  draftAcceptPct: Schema.NullOr(Schema.Finite),
  vramPeak: Schema.Array(Schema.Struct({ key: Schema.String, name: Schema.String, mib: Schema.Finite })),
  error: Schema.NullOr(Schema.String),
  durationMs: Schema.NullOr(Schema.Finite),
  /** Peak read bandwidth of the model's disk during the run (bytes/s), if measured. */
  diskReadPeakBps: Schema.NullOr(Schema.Finite),
  sweepId: Schema.NullOr(Schema.Int),
  /** Label of the item within its sweep (“-ncmoe 8 · -dev CUDA0,CUDA1”). */
  sweepLabel: Schema.NullOr(Schema.String),
  /** The estimator's verdict at planning time. */
  fit: Schema.NullOr(Fit),
  createdAt: Schema.Int,
});
export type BenchRun = typeof BenchRun.Type;

export const BenchPhase = Schema.Literals([
  'stopping-server',
  'loading',
  'warmup',
  'prompt',
  'generation',
  'measure',
  'restarting-server',
]);
export type BenchPhase = typeof BenchPhase.Type;

/** The live state of the current run. */
export const BenchLive = Schema.Struct({
  runId: Schema.Int,
  kind: BenchKind,
  phase: BenchPhase,
  step: Schema.NullOr(Schema.Struct({ index: Schema.Int, total: Schema.Int })),
  startedAt: Schema.Int,
  /** The tool's last 20 lines. */
  lines: Schema.Array(Schema.String),
});
export type BenchLive = typeof BenchLive.Type;

/** A device of `llama-bench --list-devices`, with what the monitor knows of it. */
export const BenchDevice = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  totalMib: Schema.Finite,
  freeMib: Schema.Finite,
  /** Letters of the id: "CUDA", "Vulkan", "BLAS"… */
  backend: Schema.String,
  /**
   * VRAM used by other processes than the managed llama-server (desktop, another model), from the monitor; the
   * estimator deducts it from the budget. Missing: unknown (card not matched to the monitor, or not read).
   */
  otherUsedMib: Schema.optionalKey(Schema.Finite),
}) satisfies Schema.Codec<LlamaBenchDevice & { readonly otherUsedMib?: number }>;
export type BenchDevice = typeof BenchDevice.Type;

/** What a profile gives a run: its model, projector and id, its flags split into the fields and the rest. */
export const BenchDraft = Schema.Struct({
  modelPath: Schema.String,
  mmprojPath: Schema.NullOr(Schema.String),
  profileId: Schema.Int,
  params: StoredBenchParams,
  serverArgs: Schema.Array(Schema.String),
});
export type BenchDraft = typeof BenchDraft.Type;

const isOneOf =
  <const L extends ReadonlyArray<string>>(literals: L) =>
  (raw: string): Option.Option<L[number]> =>
    Arr.findFirst(literals, (literal) => literal === raw);

/** A number written in decimal (`-2`, `0.5`), if it is one. */
const numberOf = (s: string): Option.Option<number> =>
  /^-?\d+(\.\d+)?$/.test(s) ? Option.some(Number(s)) : Option.none();
/** A non-negative integer written in digits, if it is one. */
const intOf = (s: string): Option.Option<number> => (/^\d+$/.test(s) ? Option.some(Number(s)) : Option.none());
const listOf = (s: string): Array<string> => Arr.filter(Str.split(s, ','), Str.isNonEmpty);

/** Parsed value for a field, or none if unreadable (the flag then stays in `rest`). */
function readValue(key: Key, raw: string): Option.Option<BenchParams[Key]> {
  switch (key) {
    case 'ngl':
      return raw === 'all' || raw === 'auto' ? Option.some(raw) : intOf(raw);
    case 'ot':
    case 'dev':
      return Option.some(listOf(raw));
    case 'ts': {
      const parts = Arr.map(listOf(raw), numberOf);
      return Arr.isArrayNonEmpty(parts) ? Option.all(parts) : Option.none();
    }
    case 'sm':
      return isOneOf(SPLIT_MODES)(raw);
    case 'fa':
      return isOneOf(FLASH_ATTN)(raw);
    case 'ctk':
    case 'ctv':
      return isOneOf(CACHE_TYPES)(raw);
    default:
      return intOf(raw);
  }
}

/** Splits a llama-server profile's args: flags covered by a field, and the rest in their original order. */
export function paramsFromServerArgs(args: ReadonlyArray<string>): { params: BenchParams; rest: Array<string> } {
  const params: { -readonly [K in Key]?: BenchParams[K] } = {};
  const rest: Array<string> = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? '';
    const eq = Option.getOrElse(Str.indexOf('=')(arg), () => -1);
    const flag = Str.startsWith('-')(arg) && eq > 0 ? Str.slice(0, eq)(arg) : arg;
    const field = BY_FLAG.get(flag);
    if (field === undefined) {
      rest.push(arg);
      continue;
    }
    let raw: string | undefined;
    const taken: Array<string> = [arg];
    if (eq > 0 && flag !== arg) raw = Str.slice(eq + 1)(arg);
    else if (field.key === 'fa') {
      // -fa without a value (old form) = on.
      const next = args[i + 1];
      if (next !== undefined && Option.isSome(isOneOf(FLASH_ATTN)(next))) {
        raw = next;
        taken.push(next);
        i++;
      } else raw = 'on';
    } else if (i + 1 < args.length) {
      raw = args[++i] ?? '';
      taken.push(raw);
    }
    const value = raw === undefined ? Option.none() : readValue(field.key, raw);
    if (raw === undefined || Option.isNone(value)) {
      rest.push(...taken);
      continue;
    }
    // Each `-ot` adds its rules (`readValue` reads them by `listOf`)
    if (field.key === 'ot') params.ot = [...(params.ot ?? []), ...listOf(raw)];
    else (params as Record<string, unknown>)[field.key] = value.value;
  }
  return { params, rest };
}

/** The context size set by a profile's args (`-c`, `--ctx-size`, `=` form); undefined when absent or invalid. */
export function ctxFromArgs(args: ReadonlyArray<string>): number | undefined {
  let out: number | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? '';
    let raw: string | undefined;
    if (arg === '-c' || arg === '--ctx-size') raw = args[++i];
    else if (Str.startsWith('--ctx-size=')(arg) || Str.startsWith('-c=')(arg))
      raw = Str.slice(Str.indexOf('=')(arg).pipe(Option.getOrElse(() => -1)) + 1)(arg);
    if (raw === undefined) continue;
    const n = Number(raw);
    out = Number.isInteger(n) && n > 0 ? n : undefined;
  }
  return out;
}

/** `args` with `-c <ctx>` appended when they set no context: llama-server would otherwise allocate the model's full one. */
export const withCtx: {
  (ctx: number | null | undefined): (args: ReadonlyArray<string>) => ReadonlyArray<string>;
  (args: ReadonlyArray<string>, ctx: number | null | undefined): ReadonlyArray<string>;
} = dual(2, (args: ReadonlyArray<string>, ctx: number | null | undefined): ReadonlyArray<string> =>
  Predicate.isNumber(ctx) && ctx !== 0 && !Number.isNaN(ctx) && ctxFromArgs(args) === undefined
    ? [...args, '-c', String(ctx)]
    : args,
);

/** One field's value as the tool's flag value, none when the tool's default applies. */
function flagValue(key: Key, value: NonNullable<BenchParams[Key]>, tool: BenchKind): Option.Option<string> {
  if (key === 'ngl' && value === 'auto') return Option.none();
  if (Arr.isArray(value)) {
    if (!Arr.isArrayNonEmpty(value)) return Option.none();
    const parts = Arr.map(value, String);
    if (key === 'ot') return Option.some(Arr.join(parts, tool === 'bench' ? ';' : ','));
    return Option.some(Arr.join(parts, tool === 'bench' ? '/' : ','));
  }
  if (key === 'ngl' && value === 'all') return Option.some(tool === 'bench' ? '999' : 'all');
  return Option.some(String(value));
}

function toArgs(p: BenchParams, tool: BenchKind): Array<string> {
  return Arr.flatMap(FIELDS, ({ key, short }) => {
    const value = p[key];
    if (value === undefined) return [];
    return Option.match(flagValue(key, value, tool), { onNone: () => [], onSome: (s) => [short, s] });
  });
}

/** The fields as llama-server flags (`,` between values). */
export const serverArgs = (p: BenchParams): Array<string> => toArgs(p, 'server');
/** The fields as llama-bench flags (`/` for -dev and -ts, `;` for -ot). */
export const benchArgs = (p: BenchParams): Array<string> => toArgs(p, 'bench');

/** Speculative flags: --spec-type, --spec-draft-n-max, --spec-default…, the draft model and its placement (#30). */
const SPECULATIVE: ReadonlyArray<string> = [
  '-md',
  '-ngld',
  '--gpu-layers-draft',
  '--n-gpu-layers-draft',
  '-devd',
  '--device-draft',
  '-cd',
  '--ctx-size-draft',
];
const IGNORED: ReadonlyArray<{ readonly test: (flag: string) => boolean; readonly why: string }> = [
  { test: (f) => f === '-c' || f === '--ctx-size', why: 'context not allocated' },
  {
    test: (f) =>
      Str.startsWith('--spec-')(f) ||
      Str.startsWith('--model-draft')(f) ||
      Str.startsWith('--draft')(f) ||
      Arr.contains(SPECULATIVE, f),
    why: 'speculative decoding not measured',
  },
  { test: (f) => f === '-cmoe' || f === '--cpu-moe', why: 'use -ncmoe' },
  { test: (f) => f === '-np' || f === '--parallel', why: 'parallel slots' },
];

/** Profile flags that change speed or memory and that llama-bench does not reproduce. */
export function ignoredByBench(rest: ReadonlyArray<string>): Array<{ flag: string; why: string }> {
  return Arr.flatMap(rest, (arg) => {
    if (!Str.startsWith('-')(arg)) return [];
    const flag = Arr.headNonEmpty(Str.split(arg, '='));
    return Option.match(
      Arr.findFirst(IGNORED, (ignored) => ignored.test(flag)),
      { onNone: () => [], onSome: ({ why }) => [{ flag, why }] },
    );
  });
}
