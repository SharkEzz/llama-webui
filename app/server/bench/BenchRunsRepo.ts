import {
  BenchHardware,
  BenchKind,
  BenchRun,
  type BenchSpec,
  BenchStatus,
  type FitVerdict,
  Measure,
  type RunsQuery,
  StoredBenchSpec,
} from '@llama-webui/shared';
import { Array as Arr, Clock, Context, Effect, Layer, Option, Predicate, Schema } from 'effect';
import { SqlClient, SqlSchema, type Statement } from 'effect/sql';

/** Most runs one list returns: the default for a sweep (all its items), and the cap of an explicit `limit`. */
export const MAX_RUNS = 10_000;

/** Most one-off runs a list returns when it names no limit. */
const DEFAULT_LIMIT = 200;

/** What a list of runs keeps: each filter absent = any value. */
export interface RunFilters {
  readonly kind: Option.Option<BenchKind>;
  readonly status: Option.Option<BenchStatus>;
  readonly modelPath: Option.Option<string>;
  /** `none`: the one-off runs; `all`: every run; an id: the items of that sweep, in queue order. */
  readonly sweep: 'none' | 'all' | number;
  readonly limit: number;
}

const isKind = Schema.is(BenchKind);
const isStatus = Schema.is(BenchStatus);

/**
 * The filters of a runs query, read as the Nitro server read them: an unknown `kind` or `status` is ignored, `sweep`
 * absent or unknown = the one-off runs, `limit` a positive integer capped at `MAX_RUNS` (else 200, `MAX_RUNS` for a
 * sweep id).
 */
export const runFilters = (query: RunsQuery): RunFilters => {
  const sweep =
    query.sweep === 'all'
      ? 'all'
      : query.sweep !== undefined && /^\d+$/.test(query.sweep)
        ? Number(query.sweep)
        : 'none';
  const limit = Number(query.limit);
  return {
    kind: Option.filter(Option.fromUndefinedOr(query.kind), isKind),
    status: Option.filter(Option.fromUndefinedOr(query.status), isStatus),
    modelPath: Option.filter(Option.fromUndefinedOr(query.model), (model) => model !== ''),
    sweep,
    limit:
      Number.isInteger(limit) && limit > 0
        ? Math.min(limit, MAX_RUNS)
        : Predicate.isNumber(sweep)
          ? MAX_RUNS
          : DEFAULT_LIMIT,
  };
};

/** The results of a run, in `stats_json`: written with every key, `diskReadPeakBps` missing from older rows. */
const Stats = Schema.Struct({
  pp: Schema.NullOr(Measure),
  tg: Schema.NullOr(Measure),
  draftAcceptPct: Schema.NullOr(Schema.Finite),
  diskReadPeakBps: Schema.optionalKey(Schema.NullOr(Schema.Finite)),
});
const StatsJson = Schema.fromJsonString(Stats);
const SpecJson = Schema.fromJsonString(StoredBenchSpec);
const HardwareJson = Schema.fromJsonString(BenchHardware);
const VramJson = Schema.fromJsonString(BenchRun.fields.vramPeak);

/** A row of `bench_runs`; its stats stay text, decoded by `runOf` (stats that do not decode are dropped). */
const Row = Schema.Struct({
  id: Schema.Int,
  kind: BenchKind,
  status: BenchStatus,
  model_path: Schema.String,
  profile_id: Schema.NullOr(Schema.Int),
  args_json: SpecJson,
  command: Schema.String,
  hardware_json: Schema.String,
  pp_tps: Schema.NullOr(Schema.Finite),
  tg_tps: Schema.NullOr(Schema.Finite),
  stats_json: Schema.NullOr(Schema.String),
  vram_mib_json: VramJson,
  error: Schema.NullOr(Schema.String),
  log_excerpt: Schema.String,
  duration_ms: Schema.NullOr(Schema.Finite),
  sweep_id: Schema.NullOr(Schema.Int),
  sweep_label: Schema.NullOr(Schema.String),
  fit: BenchRun.fields.fit,
  created_at: Schema.Int,
});

/** The hardware of a queued item, stored `{}` until it begins. */
const NO_HARDWARE: BenchHardware = { cpu: '', gpus: [], build: null };
const NO_STATS: typeof Stats.Type = { pp: null, tg: null, draftAcceptPct: null };

const decodeStats = Schema.decodeUnknownEffect(StatsJson);
const decodeHardware = Schema.decodeUnknownEffect(HardwareJson);
const encodeStats = Schema.encodeEffect(StatsJson);
const encodeSpec = Schema.encodeEffect(SpecJson);
const encodeHardware = Schema.encodeEffect(HardwareJson);
const encodeVram = Schema.encodeEffect(VramJson);

/**
 * The run of a row. Its spec takes the row's `profile_id` (null once the profile is deleted, `ON DELETE SET NULL`).
 * Stats the schema refuses (the Nitro server wrote a NaN as `null`) read as no results: the row survives.
 */
const runOf = Effect.fn('BenchRunsRepo.runOf')(function* (row: typeof Row.Type) {
  const stats =
    row.stats_json === null
      ? NO_STATS
      : yield* decodeStats(row.stats_json).pipe(
          Effect.catchTag('SchemaError', (error) =>
            Effect.logWarning(`The results of bench run ${row.id} do not decode: ${error.message}`).pipe(
              Effect.as(NO_STATS),
            ),
          ),
        );
  const hardware = row.hardware_json === '{}' ? NO_HARDWARE : yield* decodeHardware(row.hardware_json);
  const run: BenchRun = {
    id: row.id,
    kind: row.kind,
    status: row.status,
    spec: { ...row.args_json, profileId: row.profile_id },
    command: row.command,
    hardware,
    pp: stats.pp,
    tg: stats.tg,
    draftAcceptPct: stats.draftAcceptPct,
    vramPeak: row.vram_mib_json,
    error: row.error,
    logExcerpt: row.log_excerpt,
    durationMs: row.duration_ms,
    diskReadPeakBps: stats.diskReadPeakBps ?? null,
    sweepId: row.sweep_id,
    sweepLabel: row.sweep_label,
    fit: row.fit,
    createdAt: row.created_at,
  };
  return run;
});

/** What `finish` writes over a run: an omitted field is kept. */
export type BenchFinish = Partial<
  Pick<
    BenchRun,
    'status' | 'pp' | 'tg' | 'draftAcceptPct' | 'vramPeak' | 'error' | 'logExcerpt' | 'durationMs' | 'diskReadPeakBps'
  >
>;

/** A new run: a one-off run (`running`), or an item of a sweep. */
export interface NewRun {
  readonly spec: BenchSpec;
  readonly command: string;
  readonly hardware: BenchHardware;
  readonly status: BenchStatus;
  readonly sweepId?: number;
  readonly label?: string;
  readonly fit?: FitVerdict;
}

/** An item of a sweep to queue. */
export interface QueuedItem {
  readonly spec: BenchSpec;
  readonly label: string;
  readonly fit: FitVerdict;
}

/** The benchmark runs (`bench_runs`), one-off runs and sweep items, as the Nitro server stored them. */
export class BenchRunsRepo extends Context.Service<
  BenchRunsRepo,
  {
    /** A new run; its profile is kept only if it still exists (else none). */
    readonly create: (run: NewRun) => Effect.Effect<BenchRun>;
    /** A sweep's items, `queued` in the given order, in one transaction (command and hardware set at `begin`). */
    readonly enqueue: (sweepId: number, items: ReadonlyArray<QueuedItem>) => Effect.Effect<ReadonlyArray<BenchRun>>;
    /** A queued item starts: `running`, its command and hardware frozen, its date the start. */
    readonly begin: (
      id: number,
      start: { readonly command: string; readonly hardware: BenchHardware },
    ) => Effect.Effect<BenchRun>;
    /** The first queued item of a sweep. */
    readonly nextQueued: (sweepId: number) => Effect.Effect<Option.Option<BenchRun>>;
    /** Back in the queue, its results cleared: it will be replayed. */
    readonly requeue: (id: number) => Effect.Effect<void>;
    /** `requeue` of every interrupted item of a sweep; how many. */
    readonly requeueInterrupted: (sweepId: number) => Effect.Effect<number>;
    /** The queued items of a sweep become `cancelled`; how many. */
    readonly cancelQueued: (sweepId: number) => Effect.Effect<number>;
    /** Writes the results of a run over what it holds. */
    readonly finish: (id: number, result: BenchFinish) => Effect.Effect<BenchRun>;
    /** The runs `filters` keeps: newest first, a sweep's items in queue order. */
    readonly list: (filters: RunFilters) => Effect.Effect<ReadonlyArray<BenchRun>>;
    readonly get: (id: number) => Effect.Effect<Option.Option<BenchRun>>;
    /**
     * The latest successful one-off run of each profile, by profile id (sweep items test other settings than the
     * profile's own, and a run whose profile was deleted has none).
     */
    readonly lastOkByProfile: Effect.Effect<ReadonlyMap<number, BenchRun>>;
    /** Whether a row went. */
    readonly delete: (id: number) => Effect.Effect<boolean>;
    /** Deletes the failed, cancelled and interrupted one-off runs (sweep items stay); their ids. */
    readonly deleteFailed: Effect.Effect<ReadonlyArray<number>>;
    /** At startup: a run left `running` (the app stopped abruptly) becomes `interrupted`; how many. */
    readonly stopOrphans: Effect.Effect<number>;
  }
>()('@llama-webui/app/server/bench/BenchRunsRepo') {
  static readonly layer: Layer.Layer<BenchRunsRepo, never, SqlClient.SqlClient> = Layer.effect(
    BenchRunsRepo,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      const findById = SqlSchema.findOneOption({
        Request: Schema.Int,
        Result: Row,
        execute: (id) => sql`SELECT * FROM bench_runs WHERE id = ${id}`,
      });
      const findNextQueued = SqlSchema.findOneOption({
        Request: Schema.Int,
        Result: Row,
        execute: (sweepId) =>
          sql`SELECT * FROM bench_runs WHERE sweep_id = ${sweepId} AND status = 'queued' ORDER BY id LIMIT 1`,
      });
      const findLastOk = SqlSchema.findAll({
        Request: Schema.Void,
        Result: Row,
        execute: () =>
          sql`SELECT * FROM bench_runs b WHERE b.id = (
                SELECT id FROM bench_runs WHERE profile_id = b.profile_id AND status = 'ok' AND sweep_id IS NULL
                ORDER BY created_at DESC, id DESC LIMIT 1)`,
      });

      /** The run of `id`: a row the caller holds the id of (one missing is a defect). */
      const byId = (id: number) =>
        findById(id).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.die(`bench run ${id} is not in the table`),
              onSome: runOf,
            }),
          ),
        );

      /** The run of a row that may be missing. */
      const optionalRun = (row: Option.Option<typeof Row.Type>) =>
        Option.match(row, {
          onNone: () => Effect.succeed(Option.none<BenchRun>()),
          onSome: (found) => Effect.asSome(runOf(found)),
        });

      /** Inserts a run; `hardware` is its JSON (`{}` for a queued item). */
      const insert = Effect.fn('BenchRunsRepo.insert')(function* (
        run: Omit<NewRun, 'hardware'> & { readonly hardware: string },
      ) {
        const spec = yield* encodeSpec(run.spec);
        const now = yield* Clock.currentTimeMillis;
        const rows = yield* sql`INSERT INTO bench_runs(kind, status, model_path, profile_id, args_json, command,
            hardware_json, vram_mib_json, sweep_id, sweep_label, fit, created_at)
          VALUES (${run.spec.kind}, ${run.status}, ${run.spec.modelPath},
            (SELECT id FROM profiles WHERE id = CAST(${run.spec.profileId} AS INTEGER)), ${spec}, ${run.command},
            ${run.hardware}, '[]', ${run.sweepId ?? null}, ${run.label ?? null}, ${run.fit ?? null}, ${now})
          RETURNING *`;
        const [row] = yield* Schema.decodeUnknownEffect(Schema.Array(Row))(rows);
        return row === undefined ? yield* Effect.die('INSERT … RETURNING gave no row') : yield* runOf(row);
      });

      const create = Effect.fn('BenchRunsRepo.create')(
        function* (run: NewRun) {
          const hardware = yield* encodeHardware(run.hardware);
          return yield* insert({ ...run, hardware });
        },
        Effect.catchTags({ SqlError: Effect.die, SchemaError: Effect.die }),
      );

      const enqueue = Effect.fn('BenchRunsRepo.enqueue')(
        function* (sweepId: number, items: ReadonlyArray<QueuedItem>) {
          return yield* Effect.forEach(items, (item) =>
            insert({
              spec: item.spec,
              command: '',
              hardware: '{}',
              status: 'queued',
              sweepId,
              label: item.label,
              fit: item.fit,
            }),
          );
        },
        sql.withTransaction,
        Effect.catchTags({ SqlError: Effect.die, SchemaError: Effect.die }),
      );

      const begin = Effect.fn('BenchRunsRepo.begin')(
        function* (id: number, start: { readonly command: string; readonly hardware: BenchHardware }) {
          const hardware = yield* encodeHardware(start.hardware);
          const now = yield* Clock.currentTimeMillis;
          yield* sql`UPDATE bench_runs SET ${sql.update({
            status: 'running',
            command: start.command,
            hardware_json: hardware,
            created_at: now,
          })} WHERE id = ${id}`;
          return yield* byId(id);
        },
        Effect.catchTags({ SqlError: Effect.die, SchemaError: Effect.die }),
      );

      const nextQueued = Effect.fn('BenchRunsRepo.nextQueued')(
        function* (sweepId: number) {
          const row = yield* findNextQueued(sweepId);
          return yield* optionalRun(row);
        },
        Effect.catchTags({ SqlError: Effect.die, SchemaError: Effect.die }),
      );

      /** Clears the results of the runs `where` selects and queues them again; how many. */
      const requeueWhere = (where: Statement.Fragment) =>
        sql`UPDATE bench_runs SET status = 'queued', error = NULL, stats_json = NULL, pp_tps = NULL, tg_tps = NULL,
              vram_mib_json = '[]', log_excerpt = '', duration_ms = NULL
            WHERE ${where} RETURNING id`.pipe(Effect.map((rows) => rows.length));

      const requeue = Effect.fn('BenchRunsRepo.requeue')(function* (id: number) {
        yield* Effect.orDie(requeueWhere(sql.and([sql`id = ${id}`])));
      });

      const requeueInterrupted = Effect.fn('BenchRunsRepo.requeueInterrupted')(function* (sweepId: number) {
        return yield* Effect.orDie(requeueWhere(sql.and([sql`sweep_id = ${sweepId}`, sql`status = 'interrupted'`])));
      });

      const cancelQueued = Effect.fn('BenchRunsRepo.cancelQueued')(function* (sweepId: number) {
        const rows = yield* Effect.orDie(
          sql`UPDATE bench_runs SET status = 'cancelled' WHERE sweep_id = ${sweepId} AND status = 'queued' RETURNING id`,
        );
        return rows.length;
      });

      const finish = Effect.fn('BenchRunsRepo.finish')(
        function* (id: number, result: BenchFinish) {
          const next = { ...(yield* byId(id)), ...result };
          const stats = yield* encodeStats({
            pp: next.pp,
            tg: next.tg,
            draftAcceptPct: next.draftAcceptPct,
            diskReadPeakBps: next.diskReadPeakBps,
          });
          const vram = yield* encodeVram(next.vramPeak);
          yield* sql`UPDATE bench_runs SET ${sql.update({
            status: next.status,
            pp_tps: next.pp?.tps ?? null,
            tg_tps: next.tg?.tps ?? null,
            stats_json: stats,
            vram_mib_json: vram,
            error: next.error,
            log_excerpt: next.logExcerpt,
            duration_ms: next.durationMs,
          })} WHERE id = ${id}`;
          return yield* byId(id);
        },
        sql.withTransaction,
        Effect.catchTags({ SqlError: Effect.die, SchemaError: Effect.die }),
      );

      const list = Effect.fn('BenchRunsRepo.list')(
        function* (filters: RunFilters) {
          const where = Arr.getSomes([
            Option.map(filters.kind, (kind) => sql`kind = ${kind}`),
            Option.map(filters.modelPath, (path) => sql`model_path = ${path}`),
            Option.map(filters.status, (status) => sql`status = ${status}`),
            filters.sweep === 'none'
              ? Option.some(sql`sweep_id IS NULL`)
              : filters.sweep === 'all'
                ? Option.none()
                : Option.some(sql`sweep_id = CAST(${filters.sweep} AS INTEGER)`),
          ]);
          const order = Predicate.isNumber(filters.sweep)
            ? sql.literal('id ASC')
            : sql.literal('created_at DESC, id DESC');
          const rows = yield* sql`SELECT * FROM bench_runs
            ${Arr.isArrayNonEmpty(where) ? sql`WHERE ${sql.and(where)}` : sql.literal('')}
            ORDER BY ${order} LIMIT CAST(${filters.limit} AS INTEGER)`;
          const decoded = yield* Schema.decodeUnknownEffect(Schema.Array(Row))(rows);
          return yield* Effect.forEach(decoded, runOf);
        },
        Effect.catchTags({ SqlError: Effect.die, SchemaError: Effect.die }),
      );

      const get = Effect.fn('BenchRunsRepo.get')(
        function* (id: number) {
          const row = yield* findById(id);
          return yield* optionalRun(row);
        },
        Effect.catchTags({ SqlError: Effect.die, SchemaError: Effect.die }),
      );

      const lastOkByProfile = Effect.gen(function* () {
        const rows = yield* findLastOk();
        const runs = yield* Effect.forEach(rows, runOf);
        return new Map(Arr.flatMap(runs, (run) => (run.spec.profileId === null ? [] : [[run.spec.profileId, run]])));
      }).pipe(
        Effect.catchTags({ SqlError: Effect.die, SchemaError: Effect.die }),
        Effect.withSpan('BenchRunsRepo.lastOkByProfile'),
      );

      const remove = Effect.fn('BenchRunsRepo.delete')(function* (id: number) {
        const rows = yield* Effect.orDie(sql`DELETE FROM bench_runs WHERE id = ${id} RETURNING id`);
        return Arr.isReadonlyArrayNonEmpty(rows);
      });

      const deleteFailed = sql<{ readonly id: number }>`DELETE FROM bench_runs
        WHERE sweep_id IS NULL AND status IN ('failed', 'cancelled', 'interrupted') RETURNING id`.pipe(
        Effect.map(Arr.map((row) => row.id)),
        Effect.orDie,
        Effect.withSpan('BenchRunsRepo.deleteFailed'),
      );

      const stopOrphans = sql`UPDATE bench_runs SET status = 'interrupted',
          error = COALESCE(error, 'interrupted (llama-webui stopped)') WHERE status = 'running' RETURNING id`.pipe(
        Effect.map((rows) => rows.length),
        Effect.orDie,
        Effect.withSpan('BenchRunsRepo.stopOrphans'),
      );

      return BenchRunsRepo.of({
        create,
        enqueue,
        begin,
        nextQueued,
        requeue,
        requeueInterrupted,
        cancelQueued,
        finish,
        list,
        get,
        lastOkByProfile,
        delete: remove,
        deleteFailed,
        stopOrphans,
      });
    }),
  );
}
