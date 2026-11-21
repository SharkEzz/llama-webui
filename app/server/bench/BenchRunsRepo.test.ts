import { NodeServices } from '@effect/platform-node';
import { SqliteClient } from '@effect/sql-sqlite-node';
import { assert, describe, it, layer } from '@effect/vitest';
import { BenchHardware, StoredBenchSpec } from '@llama-webui/shared';
import { Array as Arr, Context, Effect, FileSystem, Layer, Option, Order, Path, Record, Schema } from 'effect';
import { SqlClient } from 'effect/sql';
import { TestClock } from 'effect/testing';
import * as Db from '../db/Db.ts';
import { MIGRATIONS } from '../db/migrations.ts';
import { benchSpec, fresh, NO_HARDWARE, sweepSpec } from '../testing/bench.ts';
import { BenchRunsRepo, MAX_RUNS, runFilters } from './BenchRunsRepo.ts';
import { SweepsRepo } from './SweepsRepo.ts';

/** `f` on the SqlClient of `client`, closed after. */
const using = <A, E, E2, R>(
  client: Layer.Layer<SqlClient.SqlClient, E2, R>,
  f: (sql: SqlClient.SqlClient) => Effect.Effect<A, E, SqlClient.SqlClient>,
) =>
  Layer.build(client).pipe(
    Effect.flatMap((context) => Effect.provideContext(f(Context.get(context, SqlClient.SqlClient)), context)),
    Effect.scoped,
  );

const ids = (runs: ReadonlyArray<{ readonly id: number }>) => Arr.map(runs, (run) => run.id);

describe('BenchRunsRepo', () => {
  it.effect('a run whose profile no longer exists is created without it', () =>
    fresh(
      Effect.gen(function* () {
        const runs = yield* BenchRunsRepo;
        const run = yield* runs.create({
          spec: benchSpec({ profileId: 42 }),
          command: 'cmd',
          hardware: NO_HARDWARE,
          status: 'running',
        });
        assert.strictEqual(run.spec.profileId, null);
      }),
    ),
  );

  it.effect("a deleted run's id is never handed out again", () =>
    fresh(
      Effect.gen(function* () {
        const runs = yield* BenchRunsRepo;
        const make = (command: string) =>
          runs.create({ spec: benchSpec(), command, hardware: NO_HARDWARE, status: 'running' });
        yield* make('a');
        const b = yield* make('b');
        const deleted = yield* runs.delete(b.id);
        assert.isTrue(deleted);
        const gone = yield* runs.delete(b.id);
        assert.isFalse(gone);
        const c = yield* make('c');
        assert.isTrue(c.id > b.id);
      }),
    ),
  );

  it('runFilters ignores unknown values, caps limit at 10,000 and defaults it to 200 or 10,000 for a sweep', () => {
    assert.deepStrictEqual(runFilters({}), {
      kind: Option.none(),
      status: Option.none(),
      modelPath: Option.none(),
      sweep: 'none',
      limit: 200,
    });
    assert.deepStrictEqual(
      runFilters({ kind: 'server', status: 'ok', model: '/m/a.gguf', sweep: 'all', limit: '50' }),
      {
        kind: Option.some('server' as const),
        status: Option.some('ok' as const),
        modelPath: Option.some('/m/a.gguf'),
        sweep: 'all',
        limit: 50,
      },
    );
    const odd = runFilters({ kind: 'nope', status: 'weird', model: '', sweep: 'x1', limit: '-3' });
    assert.deepStrictEqual(odd, {
      kind: Option.none(),
      status: Option.none(),
      modelPath: Option.none(),
      sweep: 'none',
      limit: 200,
    });
    assert.deepStrictEqual(runFilters({ sweep: '7' }).sweep, 7);
    assert.strictEqual(runFilters({ sweep: '7' }).limit, MAX_RUNS);
    assert.strictEqual(runFilters({ sweep: '7', limit: '2.5' }).limit, MAX_RUNS);
    assert.strictEqual(runFilters({ limit: '20000' }).limit, MAX_RUNS);
  });

  it.effect('GET /api/bench/runs caps an explicit limit at the sweep default, 10,000 (#37)', () =>
    fresh(
      Effect.gen(function* () {
        assert.strictEqual(MAX_RUNS, 10_000);
        assert.strictEqual(runFilters({ limit: '20000' }).limit, MAX_RUNS);
        assert.strictEqual(runFilters({ limit: '7000' }).limit, 7000);
        // The list takes the limit it is given.
        const runs = yield* BenchRunsRepo;
        for (const command of ['a', 'b', 'c'])
          yield* runs.create({ spec: benchSpec(), command, hardware: NO_HARDWARE, status: 'running' });
        const two = yield* runs.list(runFilters({ limit: '2' }));
        assert.deepStrictEqual(
          Arr.map(two, (run) => run.command),
          ['c', 'b'],
        );
      }),
    ),
  );

  it.effect('deleteFailed deletes only one-off failed, cancelled and interrupted runs and returns their ids', () =>
    fresh(
      Effect.gen(function* () {
        const runs = yield* BenchRunsRepo;
        const sweeps = yield* SweepsRepo;
        const oneOff = Effect.fn('oneOff')(function* (status: 'ok' | 'failed' | 'cancelled' | 'interrupted') {
          const run = yield* runs.create({
            spec: benchSpec(),
            command: status,
            hardware: NO_HARDWARE,
            status: 'running',
          });
          return yield* runs.finish(run.id, { status });
        });
        const ok = yield* oneOff('ok');
        const failed = yield* oneOff('failed');
        const cancelled = yield* oneOff('cancelled');
        const interrupted = yield* oneOff('interrupted');
        const running = yield* runs.create({
          spec: benchSpec(),
          command: 'r',
          hardware: NO_HARDWARE,
          status: 'running',
        });
        const s = yield* sweeps.create(sweepSpec());
        const [item] = yield* runs.enqueue(s.id, [{ spec: benchSpec(), label: '-ncmoe 0', fit: 'fits' }]);
        assert(item !== undefined);
        yield* runs.finish(item.id, { status: 'failed' });

        const deleted = yield* runs.deleteFailed;
        assert.deepStrictEqual(Arr.sort(deleted, Order.Number), [failed.id, cancelled.id, interrupted.id]);
        const left = yield* runs.list(runFilters({ sweep: 'all' }));
        assert.deepStrictEqual(Arr.sort(ids(left), Order.Number), [ok.id, running.id, item.id]);
        const again = yield* runs.deleteFailed;
        assert.deepStrictEqual(again, []);
      }),
    ),
  );

  it.effect('a finished run keeps its results and a requeue clears them', () =>
    fresh(
      Effect.gen(function* () {
        const runs = yield* BenchRunsRepo;
        const sweeps = yield* SweepsRepo;
        const s = yield* sweeps.create(sweepSpec());
        const [item] = yield* runs.enqueue(s.id, [{ spec: benchSpec(), label: '-ncmoe 0', fit: 'tight' }]);
        assert(item !== undefined);
        assert.deepStrictEqual([item.status, item.command, item.hardware], ['queued', '', NO_HARDWARE]);
        const hardware = {
          cpu: 'Fake CPU',
          gpus: [{ name: 'Fake GPU', busId: '0000:01:00.0', vramTotalBytes: 1024 }],
          build: 'b1 (abc)',
        };
        yield* TestClock.adjust('5 millis');
        const begun = yield* runs.begin(item.id, { command: 'llama-bench -m /m/a.gguf', hardware });
        assert.deepStrictEqual(
          [begun.status, begun.command, begun.hardware, begun.createdAt],
          ['running', 'llama-bench -m /m/a.gguf', hardware, 5],
        );
        const done = yield* runs.finish(item.id, {
          status: 'ok',
          pp: { tps: 900.5, stddev: 9, tokens: 512 },
          tg: { tps: 50.25, stddev: 0.5, tokens: 128 },
          draftAcceptPct: 47.5,
          vramPeak: [{ key: 'nvidia:GPU-1', name: 'Fake GPU', mib: 2048 }],
          logExcerpt: 'line',
          durationMs: 1234,
          diskReadPeakBps: 1.5e9,
        });
        const got = yield* runs.get(item.id);
        assert.deepStrictEqual(got, Option.some(done));
        assert.deepStrictEqual(
          [done.pp?.tps, done.tg?.tps, done.draftAcceptPct, done.diskReadPeakBps, done.fit],
          [900.5, 50.25, 47.5, 1.5e9, 'tight'],
        );
        yield* runs.finish(item.id, { status: 'interrupted', error: 'interrupted (llama-webui stopped)' });
        const requeued = yield* runs.requeueInterrupted(s.id);
        assert.strictEqual(requeued, 1);
        const next = yield* runs.nextQueued(s.id);
        assert(Option.isSome(next));
        assert.deepStrictEqual(
          [
            next.value.status,
            next.value.pp,
            next.value.tg,
            next.value.error,
            next.value.vramPeak,
            next.value.durationMs,
          ],
          ['queued', null, null, null, [], null],
        );
      }),
    ),
  );
});

// On a file of its own: the platform's file system for the temporary folder.
layer(NodeServices.layer)('BenchRunsRepo on a J5 database', (it) => {
  it.effect('the migration keeps every run of a J5 database: ids, values and the next id', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: 'lw-bench-' });
      const file = path.join(dir, 'llama-webui.sqlite');
      const spec = benchSpec();
      const specJson = yield* Schema.encodeEffect(Schema.fromJsonString(StoredBenchSpec))(spec);
      const hardwareJson = yield* Schema.encodeEffect(Schema.fromJsonString(BenchHardware))(NO_HARDWARE);
      // A J5 database, as the Nitro server left it: the schema up to `bench_runs` and its index (8), before sweeps (9)
      // and the AUTOINCREMENT rebuild, its version in `schema_version`.
      yield* using(SqliteClient.layer({ filename: file }), (sql) =>
        Effect.gen(function* () {
          for (const migration of Arr.take(Record.values(MIGRATIONS), 8)) yield* migration;
          yield* sql`CREATE TABLE schema_version(version INTEGER NOT NULL)`;
          yield* sql`INSERT INTO schema_version(version) VALUES (8)`;
          for (const [id, pp] of [
            [1, 100.5],
            [2, 200.5],
            [3, 300.5],
            [4, null],
          ] as const)
            yield* sql`INSERT INTO bench_runs(id, kind, status, model_path, args_json, command, hardware_json, pp_tps,
                  vram_mib_json, created_at)
                VALUES (${id}, 'bench', ${pp === null ? 'failed' : 'ok'}, '/m/a.gguf', ${specJson}, 'cmd',
                  ${hardwareJson}, ${pp}, '[]', ${id})`;
          // A gap: the migration copies the ids, it does not renumber them.
          yield* sql`DELETE FROM bench_runs WHERE id = 2`;
        }),
      );

      const Opened = BenchRunsRepo.layer.pipe(Layer.provideMerge(Db.layerAt(file)));
      yield* Layer.build(Opened).pipe(
        Effect.flatMap((context) =>
          Effect.provideContext(
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient;
              const runs = yield* BenchRunsRepo;
              const version = yield* sql`SELECT version FROM schema_version`;
              assert.deepStrictEqual(version, [{ version: Record.size(MIGRATIONS) }]);
              const rows = yield* sql`SELECT id, status, pp_tps FROM bench_runs ORDER BY id`;
              assert.deepStrictEqual(rows, [
                { id: 1, status: 'ok', pp_tps: 100.5 },
                { id: 3, status: 'ok', pp_tps: 300.5 },
                { id: 4, status: 'failed', pp_tps: null },
              ]);
              const all = yield* runs.list(runFilters({ sweep: 'all', limit: '1000' }));
              assert.deepStrictEqual(Arr.sort(ids(all), Order.Number), [1, 3, 4]);
              // Ids now come from AUTOINCREMENT, seeded by the copied rows: a deleted id is never handed out again.
              const next = yield* runs.create({ spec, command: 'x', hardware: NO_HARDWARE, status: 'running' });
              assert.strictEqual(next.id, 5);
              yield* runs.delete(next.id);
              const after = yield* runs.create({ spec, command: 'y', hardware: NO_HARDWARE, status: 'running' });
              assert.strictEqual(after.id, 6);
            }),
            context,
          ),
        ),
        Effect.scoped,
      );
    }),
  );
});
