import { assert, describe, it } from '@effect/vitest';
import type { BenchSpec } from '@llama-webui/shared';
import { Array as Arr, Effect, Option } from 'effect';
import { benchSpec, fresh, NO_HARDWARE, sweepSpec } from '../testing/bench.ts';
import { BenchRunsRepo, runFilters } from './BenchRunsRepo.ts';
import { SweepsRepo } from './SweepsRepo.ts';

/** `n` items of a sweep over `-ncmoe`. */
const items = (n: number) =>
  Arr.makeBy(n, (i) => ({
    spec: { ...benchSpec(), params: { ncmoe: i } } satisfies BenchSpec,
    label: `-ncmoe ${i}`,
    fit: 'fits' as const,
  }));

describe('SweepsRepo', () => {
  it.effect('a sweep counts its queued items, cascades on delete and forgets a deleted best run', () =>
    fresh(
      Effect.gen(function* () {
        const runs = yield* BenchRunsRepo;
        const sweeps = yield* SweepsRepo;
        const s = yield* sweeps.create(sweepSpec());
        const queued = yield* runs.enqueue(s.id, items(3));
        assert.deepStrictEqual(
          Arr.map(queued, (r) => [r.status, r.sweepId, r.sweepLabel, r.fit]),
          [
            ['queued', s.id, '-ncmoe 0', 'fits'],
            ['queued', s.id, '-ncmoe 1', 'fits'],
            ['queued', s.id, '-ncmoe 2', 'fits'],
          ],
        );
        const [first, second, third] = queued;
        assert(first !== undefined && second !== undefined && third !== undefined);
        const counted = yield* sweeps.get(s.id);
        // @effect-diagnostics-next-line missedPipeableOpportunity:off
        assert(Option.isSome(counted));
        assert.strictEqual(counted.value.counts.total, 3);
        assert.strictEqual(counted.value.counts.queued, 3);
        const next = yield* runs.nextQueued(s.id);
        assert.deepStrictEqual(
          Option.map(next, (r) => r.id),
          Option.some(first.id),
        );
        yield* runs.begin(first.id, { command: 'cmd', hardware: NO_HARDWARE });
        yield* runs.finish(first.id, {
          status: 'ok',
          pp: { tps: 900, stddev: 9, tokens: 512 },
          tg: { tps: 50, stddev: 0.5, tokens: 128 },
        });
        const withBest = yield* sweeps.setStatus(s.id, 'running', { bestRunId: first.id });
        assert.deepStrictEqual(withBest.best, { label: '-ncmoe 0', kind: 'bench', ppTps: 900, tgTps: 50 });
        // Sweep runs are hidden by default.
        const oneOff = yield* runs.list(runFilters({}));
        assert.deepStrictEqual(oneOff, []);
        yield* runs.delete(first.id);
        const forgot = yield* sweeps.get(s.id);
        // @effect-diagnostics-next-line missedPipeableOpportunity:off
        assert(Option.isSome(forgot));
        assert.strictEqual(forgot.value.bestRunId, null);
        assert.strictEqual(forgot.value.best, null);
        const cancelled = yield* runs.cancelQueued(s.id);
        assert.strictEqual(cancelled, 2);
        const deleted = yield* sweeps.delete(s.id);
        assert.deepStrictEqual(deleted, Option.some({ runIds: [second.id, third.id] }));
        const left = yield* runs.list(runFilters({ sweep: 'all' }));
        assert.deepStrictEqual(left, []);
      }),
    ),
  );

  it.effect('stopOrphans interrupts running sweeps and their running item', () =>
    fresh(
      Effect.gen(function* () {
        const runs = yield* BenchRunsRepo;
        const sweeps = yield* SweepsRepo;
        const s = yield* sweeps.create(sweepSpec());
        const [a] = yield* runs.enqueue(s.id, items(2));
        assert(a !== undefined);
        yield* runs.begin(a.id, { command: 'c', hardware: NO_HARDWARE });
        const orphanRuns = yield* runs.stopOrphans;
        assert.strictEqual(orphanRuns, 1);
        const orphanSweeps = yield* sweeps.stopOrphans;
        assert.strictEqual(orphanSweeps, 1);
        const stopped = yield* sweeps.get(s.id);
        assert.deepStrictEqual(
          Option.map(stopped, (sweep) => sweep.status),
          Option.some('interrupted'),
        );
        const run = yield* runs.get(a.id);
        assert.deepStrictEqual(
          Option.map(run, (r) => r.error),
          Option.some('interrupted (llama-webui stopped)'),
        );
        const requeued = yield* runs.requeueInterrupted(s.id);
        assert.strictEqual(requeued, 1);
        const after = yield* sweeps.get(s.id);
        assert.deepStrictEqual(
          Option.map(after, (sweep) => sweep.counts.queued),
          Option.some(2),
        );
      }),
    ),
  );

  it.effect('deleting a sweep that is gone returns none', () =>
    fresh(
      Effect.gen(function* () {
        const sweeps = yield* SweepsRepo;
        const s = yield* sweeps.create(sweepSpec());
        const first = yield* sweeps.delete(s.id);
        assert.deepStrictEqual(first, Option.some({ runIds: [] }));
        const second = yield* sweeps.delete(s.id);
        assert.deepStrictEqual(second, Option.none());
        const missing = yield* sweeps.get(s.id);
        assert.deepStrictEqual(missing, Option.none());
      }),
    ),
  );

  it.effect('the list is newest first, the running sweep is the latest running one, and a spec reads back', () =>
    fresh(
      Effect.gen(function* () {
        const sweeps = yield* SweepsRepo;
        const spec = sweepSpec({ name: 'first', serverArgs: ['-c', '8192'], includeUnfit: true });
        const a = yield* sweeps.create(spec);
        assert.deepStrictEqual(a.spec, spec);
        const b = yield* sweeps.create(sweepSpec({ name: 'second' }));
        const none = yield* sweeps.running;
        assert.deepStrictEqual(
          Option.map(none, (sweep) => sweep.id),
          Option.some(b.id),
        );
        const ended = yield* sweeps.setStatus(b.id, 'done', { finishedAt: 99 });
        assert.deepStrictEqual([ended.status, ended.finishedAt], ['done', 99]);
        const running = yield* sweeps.running;
        assert.deepStrictEqual(
          Option.map(running, (sweep) => sweep.id),
          Option.some(a.id),
        );
        const list = yield* sweeps.list;
        assert.deepStrictEqual(
          Arr.map(list, (sweep) => sweep.name),
          ['second', 'first'],
        );
      }),
    ),
  );
});
