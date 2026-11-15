import { BenchKind, StoredSweepSpec, type Sweep, type SweepSpec, SweepStatus } from '@llama-webui/shared';
import { Array as Arr, Clock, Context, Effect, Layer, Option, Schema } from 'effect';
import { SqlClient, SqlSchema } from 'effect/sql';

const SpecJson = Schema.fromJsonString(StoredSweepSpec);
const encodeSpec = Schema.encodeEffect(SpecJson);

/** A row of `sweeps`, its spec decoded. */
const Row = Schema.Struct({
  id: Schema.Int,
  name: Schema.String,
  status: SweepStatus,
  model_path: Schema.String,
  profile_id: Schema.NullOr(Schema.Int),
  spec_json: SpecJson,
  best_run_id: Schema.NullOr(Schema.Int),
  created_at: Schema.Int,
  finished_at: Schema.NullOr(Schema.Int),
});

/** The items of a sweep by status. */
const CountRow = Schema.Struct({ status: Schema.String, n: Schema.Int });

/** The best run of a sweep, as the history shows it. */
const BestRow = Schema.Struct({
  sweep_label: Schema.NullOr(Schema.String),
  kind: BenchKind,
  pp_tps: Schema.NullOr(Schema.Finite),
  tg_tps: Schema.NullOr(Schema.Finite),
});

type Counts = Sweep['counts'];
type CountKey = Exclude<keyof Counts, 'total'>;
const COUNTED: ReadonlyArray<string> = ['queued', 'running', 'ok', 'failed', 'cancelled', 'interrupted'];
const isCounted = (status: string): status is CountKey => Arr.contains(COUNTED, status);

/** The sweeps (`sweeps`); their items are runs of `bench_runs` (`sweep_id`), as the Nitro server stored them. */
export class SweepsRepo extends Context.Service<
  SweepsRepo,
  {
    /** A new sweep, `running`; its profile is kept only if it still exists (else none). */
    readonly create: (spec: SweepSpec) => Effect.Effect<Sweep>;
    /** A sweep with the count of its items by status and the summary of its best run. */
    readonly get: (id: number) => Effect.Effect<Option.Option<Sweep>>;
    /** Every sweep, the newest first. */
    readonly list: Effect.Effect<ReadonlyArray<Sweep>>;
    /** Sets the status, and the best run and the end when given. */
    readonly setStatus: (
      id: number,
      status: SweepStatus,
      options?: { readonly finishedAt?: number | null; readonly bestRunId?: number | null },
    ) => Effect.Effect<Sweep>;
    /** Deletes the sweep and its runs (cascade), in one transaction: the ids of its runs, none when it was gone. */
    readonly delete: (id: number) => Effect.Effect<Option.Option<{ readonly runIds: ReadonlyArray<number> }>>;
    /** The running sweep, if there is one. */
    readonly running: Effect.Effect<Option.Option<Sweep>>;
    /** At startup: a sweep left `running` becomes `interrupted` (Resume button), its queued items stay; how many. */
    readonly stopOrphans: Effect.Effect<number>;
  }
>()('@llama-webui/app/server/bench/SweepsRepo') {
  static readonly layer: Layer.Layer<SweepsRepo, never, SqlClient.SqlClient> = Layer.effect(
    SweepsRepo,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      const findById = SqlSchema.findOneOption({
        Request: Schema.Int,
        Result: Row,
        execute: (id) => sql`SELECT * FROM sweeps WHERE id = ${id}`,
      });
      const findAll = SqlSchema.findAll({
        Request: Schema.Void,
        Result: Row,
        execute: () => sql`SELECT * FROM sweeps ORDER BY created_at DESC, id DESC`,
      });
      const findRunning = SqlSchema.findOneOption({
        Request: Schema.Void,
        Result: Row,
        execute: () => sql`SELECT * FROM sweeps WHERE status = 'running' ORDER BY id DESC LIMIT 1`,
      });
      const findCounts = SqlSchema.findAll({
        Request: Schema.Int,
        Result: CountRow,
        execute: (id) => sql`SELECT status, count(*) AS n FROM bench_runs WHERE sweep_id = ${id} GROUP BY status`,
      });
      const findBest = SqlSchema.findOneOption({
        Request: Schema.Int,
        Result: BestRow,
        execute: (runId) => sql`SELECT sweep_label, kind, pp_tps, tg_tps FROM bench_runs WHERE id = ${runId}`,
      });

      /** The sweep of a row, its counts and best run read now. */
      const sweepOf = Effect.fn('SweepsRepo.sweepOf')(function* (row: typeof Row.Type) {
        const rows = yield* findCounts(row.id);
        const counts: { -readonly [K in keyof Counts]: number } = {
          total: 0,
          queued: 0,
          running: 0,
          ok: 0,
          failed: 0,
          cancelled: 0,
          interrupted: 0,
        };
        for (const { status, n } of rows) {
          if (isCounted(status)) counts[status] = n;
          counts.total += n;
        }
        const bestRow = row.best_run_id === null ? Option.none() : yield* findBest(row.best_run_id);
        const best = Option.match(bestRow, {
          onNone: () => null,
          onSome: (b) => ({ label: b.sweep_label, kind: b.kind, ppTps: b.pp_tps, tgTps: b.tg_tps }),
        });
        const sweep: Sweep = {
          id: row.id,
          name: row.name,
          status: row.status,
          // The source profile may have been deleted since (profile_id ON DELETE SET NULL).
          spec: { ...row.spec_json, profileId: row.profile_id },
          bestRunId: row.best_run_id,
          best,
          counts,
          createdAt: row.created_at,
          finishedAt: row.finished_at,
        };
        return sweep;
      });

      /** The sweep of a row that may be missing. */
      const optionalSweep = (row: Option.Option<typeof Row.Type>) =>
        Option.match(row, {
          onNone: () => Effect.succeed(Option.none<Sweep>()),
          onSome: (found) => Effect.asSome(sweepOf(found)),
        });

      /** The sweep of `id`: a row the caller holds the id of (one missing is a defect). */
      const byId = (id: number) =>
        findById(id).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.die(`sweep ${id} is not in the table`),
              onSome: sweepOf,
            }),
          ),
        );

      const create = Effect.fn('SweepsRepo.create')(
        function* (spec: SweepSpec) {
          const json = yield* encodeSpec(spec);
          const now = yield* Clock.currentTimeMillis;
          const rows = yield* sql<{ readonly id: number }>`INSERT INTO sweeps(name, status, model_path, profile_id,
              spec_json, created_at)
            VALUES (${spec.name}, 'running', ${spec.modelPath},
              (SELECT id FROM profiles WHERE id = CAST(${spec.profileId} AS INTEGER)), ${json}, ${now})
            RETURNING id`;
          const [row] = rows;
          return row === undefined ? yield* Effect.die('INSERT … RETURNING gave no row') : yield* byId(row.id);
        },
        Effect.catchTags({ SqlError: Effect.die, SchemaError: Effect.die }),
      );

      const get = Effect.fn('SweepsRepo.get')(
        function* (id: number) {
          const row = yield* findById(id);
          return yield* optionalSweep(row);
        },
        Effect.catchTags({ SqlError: Effect.die, SchemaError: Effect.die }),
      );

      const list = findAll().pipe(
        Effect.flatMap(Effect.forEach(sweepOf)),
        Effect.catchTags({ SqlError: Effect.die, SchemaError: Effect.die }),
        Effect.withSpan('SweepsRepo.list'),
      );

      const setStatus = Effect.fn('SweepsRepo.setStatus')(
        function* (
          id: number,
          status: SweepStatus,
          options: { readonly finishedAt?: number | null; readonly bestRunId?: number | null } = {},
        ) {
          yield* sql`UPDATE sweeps SET ${sql.update({
            status,
            ...(options.bestRunId === undefined ? {} : { best_run_id: options.bestRunId }),
            ...(options.finishedAt === undefined ? {} : { finished_at: options.finishedAt }),
          })} WHERE id = ${id}`;
          return yield* byId(id);
        },
        Effect.catchTags({ SqlError: Effect.die, SchemaError: Effect.die }),
      );

      const remove = Effect.fn('SweepsRepo.delete')(
        function* (id: number) {
          const runs = yield* sql<{
            readonly id: number;
          }>`SELECT id FROM bench_runs WHERE sweep_id = ${id} ORDER BY id`;
          const gone = yield* sql`DELETE FROM sweeps WHERE id = ${id} RETURNING id`;
          return Arr.isReadonlyArrayNonEmpty(gone)
            ? Option.some({ runIds: Arr.map(runs, (run) => run.id) })
            : Option.none<{ readonly runIds: ReadonlyArray<number> }>();
        },
        sql.withTransaction,
        Effect.orDie,
      );

      const running = findRunning().pipe(
        Effect.flatMap(optionalSweep),
        Effect.catchTags({ SqlError: Effect.die, SchemaError: Effect.die }),
        Effect.withSpan('SweepsRepo.running'),
      );

      const stopOrphans = sql`UPDATE sweeps SET status = 'interrupted' WHERE status = 'running' RETURNING id`.pipe(
        Effect.map((rows) => rows.length),
        Effect.orDie,
        Effect.withSpan('SweepsRepo.stopOrphans'),
      );

      return SweepsRepo.of({ create, get, list, setStatus, delete: remove, running, stopOrphans });
    }),
  );
}
