import { assert, describe, it } from '@effect/vitest';
import { Array as Arr, Clock, Duration, Effect, Fiber, Ref } from 'effect';
import { TestClock } from 'effect/testing';
import { MEASURE_ALL } from '../gpu.ts';
import type { NvmlSnapshot } from './protocol.ts';
import { makeSampling, type Round } from './sampling.ts';

const SNAPSHOT: NvmlSnapshot = { gpus: [], procs: [], system: { driver: null, cudaDriver: null } };

/**
 * The start of every round of the loop over `window` of the `TestClock` (from the loop's start), at `intervalMs`,
 * each round taking `roundTime`; with the samples it sent.
 */
const roundsOver = Effect.fnUntraced(function* (options: {
  readonly intervalMs: number;
  readonly roundTime: Duration.Input;
  readonly window: Duration.Input;
}) {
  const starts = yield* Ref.make<ReadonlyArray<number>>([]);
  const sent = yield* Ref.make(0);
  const sampling = yield* makeSampling(() => Ref.update(sent, (n) => n + 1));
  yield* sampling.apply({ intervalMs: options.intervalMs, needs: MEASURE_ALL });
  const origin = yield* Clock.currentTimeMillis;
  const read: Round = (_needs, at) =>
    Ref.update(starts, Arr.append(at - origin)).pipe(
      Effect.andThen(Effect.sleep(options.roundTime)),
      Effect.as(SNAPSHOT),
    );
  const loop = yield* Effect.forkChild(sampling.sample(read));
  yield* TestClock.adjust(options.window);
  yield* Fiber.interrupt(loop);
  return { starts: yield* Ref.get(starts), sent: yield* Ref.get(sent) };
});

describe('the NVML sampling loop', () => {
  it.effect('an interval below 100 ms samples every 100 ms (#124)', () =>
    Effect.gen(function* () {
      const { starts, sent } = yield* roundsOver({ intervalMs: 20, roundTime: Duration.zero, window: '450 millis' });
      assert.deepStrictEqual(starts, [0, 100, 200, 300, 400]);
      assert.strictEqual(sent, 5);
    }),
  );

  it.effect(
    "the round's own time is taken off the wait, and a round longer than the interval is followed at once (#124)",
    () =>
      Effect.gen(function* () {
        // 30 ms per round at 250 ms: a round every 250 ms, not every 280.
        const quick = yield* roundsOver({ intervalMs: 250, roundTime: '30 millis', window: '800 millis' });
        assert.deepStrictEqual(quick.starts, [0, 250, 500, 750]);
        // 300 ms per round at 250 ms: the next round starts as the last one ends.
        const slow = yield* roundsOver({ intervalMs: 250, roundTime: '300 millis', window: '700 millis' });
        assert.deepStrictEqual(slow.starts, [0, 300, 600]);
        assert.strictEqual(slow.sent, 2);
      }),
  );
});
