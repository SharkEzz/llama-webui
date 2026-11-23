import { Array as Arr, Effect, Option, Order, Schema } from 'effect';
import { dual } from 'effect/Function';
import {
  BENCH_FIELDS,
  BenchKind,
  BenchParams,
  type BenchRun,
  benchSpecBase,
  ctxFromArgs,
  FIELD_ORDER,
  StoredBenchParams,
  serverArgs,
  serverArgsField,
  storedSpecBase,
} from './bench.ts';
import { NOISE, PRESET_IDS, type PresetId, presetOf } from './tuning.ts';

/** A dimension's values: at least one, each under its field's rules. */
const values = <S extends Schema.Top>(field: S) =>
  Schema.optionalKey(Schema.Array(field).check(Schema.isMinLength(1, { message: 'at least one value' })));

/** For each flag, the values to try (strict); missing key = the base value. */
export const SweepSpace = Schema.Struct({
  ngl: values(BENCH_FIELDS.ngl),
  ot: values(BENCH_FIELDS.ot),
  ncmoe: values(BENCH_FIELDS.ncmoe),
  dev: values(BENCH_FIELDS.dev),
  ts: values(BENCH_FIELDS.ts),
  sm: values(BENCH_FIELDS.sm),
  fa: values(BENCH_FIELDS.fa),
  ctk: values(BENCH_FIELDS.ctk),
  ctv: values(BENCH_FIELDS.ctv),
  t: values(BENCH_FIELDS.t),
  b: values(BENCH_FIELDS.b),
  ub: values(BENCH_FIELDS.ub),
}).annotate({ messageUnexpectedKey: 'unknown key' });
export type SweepSpace = typeof SweepSpace.Type;

const stored = <S extends Schema.Top>(field: S) => field.pipe(Schema.Array, Schema.optionalKey);
const storedFields = StoredBenchParams.fields;

/** A sweep's space as it is stored, without the rules of `SweepSpace`. */
export const StoredSweepSpace = Schema.Struct({
  ngl: stored(storedFields.ngl.schema),
  ot: stored(storedFields.ot.schema),
  ncmoe: stored(storedFields.ncmoe.schema),
  dev: stored(storedFields.dev.schema),
  ts: stored(storedFields.ts.schema),
  sm: stored(storedFields.sm.schema),
  fa: stored(storedFields.fa.schema),
  ctk: stored(storedFields.ctk.schema),
  ctv: stored(storedFields.ctv.schema),
  t: stored(storedFields.t.schema),
  b: stored(storedFields.b.schema),
  ub: stored(storedFields.ub.schema),
}) satisfies Schema.Codec<SweepSpace>;

const nameMessage = '80 characters at most';
const Preset = Schema.Literals(PRESET_IDS);

/** A sweep as a person asks for it (strict), its defaults applied. */
export const SweepSpec = Schema.Struct({
  name: Schema.Trim.annotate({ message: 'required' })
    .check(Schema.isMinLength(1, { message: 'required' }), Schema.isMaxLength(80, { message: nameMessage }))
    .annotateKey({ messageMissingKey: 'required' }),
  ...benchSpecBase,
  preset: Preset.annotate({ message: 'unknown preset' }),
  base: BenchParams.pipe(Schema.withDecodingDefaultKey(Effect.succeed({}))),
  space: SweepSpace.pipe(Schema.withDecodingDefaultKey(Effect.succeed({}))),
  serverArgs: serverArgsField,
  includeUnfit: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(false))),
}).annotate({ messageUnexpectedKey: 'unknown key' });
export type SweepSpec = typeof SweepSpec.Type;
export type SweepSpecInput = typeof SweepSpec.Encoded;

/** A sweep's spec as it is stored: the fields of `SweepSpec` without its rules. */
export const StoredSweepSpec = Schema.Struct({
  name: Schema.String,
  ...storedSpecBase,
  preset: Preset,
  base: StoredBenchParams,
  space: StoredSweepSpace,
  serverArgs: Schema.Array(Schema.String),
  includeUnfit: Schema.Boolean,
}) satisfies Schema.Codec<SweepSpec>;

export const SweepStatus = Schema.Literals(['running', 'done', 'cancelled', 'interrupted']);
export type SweepStatus = typeof SweepStatus.Type;

/** A sweep: its spec, its best run and the count of its items by status. */
export const Sweep = Schema.Struct({
  id: Schema.Int,
  name: Schema.String,
  status: SweepStatus,
  spec: StoredSweepSpec,
  bestRunId: Schema.NullOr(Schema.Int),
  /** Summary of the best run (sweep history without loading their runs). */
  best: Schema.NullOr(
    Schema.Struct({
      label: Schema.NullOr(Schema.String),
      kind: BenchKind,
      ppTps: Schema.NullOr(Schema.Finite),
      tgTps: Schema.NullOr(Schema.Finite),
    }),
  ),
  counts: Schema.Struct({
    total: Schema.Int,
    queued: Schema.Int,
    running: Schema.Int,
    ok: Schema.Int,
    failed: Schema.Int,
    cancelled: Schema.Int,
    interrupted: Schema.Int,
  }),
  createdAt: Schema.Int,
  finishedAt: Schema.NullOr(Schema.Int),
});
export type Sweep = typeof Sweep.Type;

/** Where the running sweep is. */
export const SweepLive = Schema.Struct({
  sweepId: Schema.Int,
  runId: Schema.NullOr(Schema.Int),
  /** 1-based. */
  index: Schema.Int,
  total: Schema.Int,
  stage: Schema.Literals(['explore', 'validate']),
});
export type SweepLive = typeof SweepLive.Type;

type Params = { -readonly [K in keyof BenchParams]?: BenchParams[K] };

/**
 * Cartesian product of the space over the base, in field order. `-ts` only applies to combinations whose `-dev` has as
 * many devices (the others get none); a single device → no `-ts`. Duplicates removed; empty space → [base].
 */
export const expandSpace: {
  (space: SweepSpace): (base: BenchParams) => { items: Array<BenchParams>; droppedTs: number };
  (base: BenchParams, space: SweepSpace): { items: Array<BenchParams>; droppedTs: number };
} = dual(2, (base: BenchParams, space: SweepSpace): { items: Array<BenchParams>; droppedTs: number } => {
  let combos: Array<Params> = [{ ...base }];
  for (const key of FIELD_ORDER) {
    const vals: ReadonlyArray<unknown> | undefined = space[key];
    if (vals === undefined) continue;
    combos = Arr.flatMap(combos, (c) => Arr.map(vals, (v): Params => ({ ...c, [key]: v })));
  }
  let droppedTs = 0;
  const seen = new Set<string>();
  const items: Array<BenchParams> = [];
  for (const c of combos) {
    const out = { ...c };
    if (out.ts !== undefined) {
      const n = out.dev?.length;
      if (n === undefined || n <= 1 || n !== out.ts.length) {
        if (space.ts !== undefined) droppedTs++;
        delete out.ts;
      }
    }
    const key = Arr.join(
      Arr.map(FIELD_ORDER, (k) => String(out[k] ?? null)),
      '\u0000',
    );
    if (seen.has(key)) continue;
    seen.add(key);
    items.push(out);
  }
  return { items, droppedTs };
});

/** Only the space's dimensions, as llama-server flags: “-ngl all · -ncmoe 8 · -dev CUDA0,Vulkan3”. */
export const itemLabel: {
  (space: SweepSpace): (params: BenchParams) => string;
  (params: BenchParams, space: SweepSpace): string;
} = dual(2, (params: BenchParams, space: SweepSpace): string => {
  const parts = Arr.flatMap(FIELD_ORDER, (key) => {
    if (space[key] === undefined) return [];
    const args = serverArgs({ [key]: params[key] });
    return [Arr.isArrayNonEmpty(args) ? Arr.join(args, ' ') : `-${key} default`];
  });
  return Arr.isArrayNonEmpty(parts) ? Arr.join(parts, ' · ') : 'base';
});

/** Context of a sweep: the -c from the other server flags (as `ctxFromArgs` reads it), otherwise the preset's minimum. */
export function sweepCtx(spec: Pick<SweepSpec, 'serverArgs' | 'preset'>): number {
  return ctxFromArgs(spec.serverArgs) ?? presetOf(spec.preset).ctxMin;
}

/** What a run is scored against: the sweep's preset and its context. */
export interface ScoreOptions {
  readonly preset: PresetId;
  readonly ctx: number;
}

/** The preset's score for a successful run; null otherwise. */
export const scoreOf: {
  (options: ScoreOptions): (run: Pick<BenchRun, 'status' | 'pp' | 'tg'>) => number | null;
  (run: Pick<BenchRun, 'status' | 'pp' | 'tg'>, options: ScoreOptions): number | null;
} = dual(2, (run: Pick<BenchRun, 'status' | 'pp' | 'tg'>, { preset, ctx }: ScoreOptions): number | null =>
  run.status === 'ok' && run.pp !== null && run.tg !== null
    ? presetOf(preset).score({ ppTps: run.pp.tps, tgTps: run.tg.tps, ctx })
    : null,
);

export interface Ranked {
  run: BenchRun;
  score: number | null;
  rank: number | null;
  /** The gap to the best is within measurement noise (also set on the best when it has a tie). */
  tie: boolean;
}

/** Successful runs by decreasing score, then the others in their original order. */
export const rankRuns: {
  (options: ScoreOptions): (runs: ReadonlyArray<BenchRun>) => Array<Ranked>;
  (runs: ReadonlyArray<BenchRun>, options: ScoreOptions): Array<Ranked>;
} = dual(2, (runs: ReadonlyArray<BenchRun>, options: ScoreOptions): Array<Ranked> => {
  const { preset, ctx } = options;
  const scored = Arr.map(runs, (run) => ({ run, score: scoreOf(run, options) }));
  const ok = Arr.sort(
    Arr.getSomes(Arr.map(scored, ({ run, score }) => (score === null ? Option.none() : Option.some({ run, score })))),
    Order.flip(Order.mapInput(Order.Number, (s: { readonly score: number }) => s.score)),
  );
  const rest = Arr.filter(scored, (s) => s.score === null);
  const best = Arr.head(ok);
  const band = Option.match(best, {
    onNone: () => 0,
    onSome: ({ run, score }) =>
      run.pp !== null && run.tg !== null
        ? score -
          presetOf(preset).score({ ppTps: run.pp.tps * (1 - NOISE.pp), tgTps: run.tg.tps * (1 - NOISE.tg), ctx })
        : 0,
  });
  const top = Option.match(best, { onNone: () => 0, onSome: (b) => b.score });
  const ranked: Array<Ranked> = Arr.map(ok, (s, i) => ({ ...s, rank: i + 1, tie: i > 0 && top - s.score <= band }));
  const [first, ...others] = ranked;
  if (first !== undefined && Arr.some(others, (r) => r.tie)) first.tie = true;
  return [...ranked, ...Arr.map(rest, (s) => ({ ...s, rank: null, tie: false }))];
});

const LOAD_BYTES_PER_SEC = 1.5 * 1024 ** 3;

/** Rough duration of a sweep: one load per item plus ~10 s per repetition. */
export function estimatedSweepSeconds(o: { items: number; fileBytes: number; r: number }): number {
  return Math.round(o.items * (o.fileBytes / LOAD_BYTES_PER_SEC + 10 * o.r));
}
