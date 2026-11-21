import { assert, describe, it } from '@effect/vitest';
import { Effect, Option } from 'effect';
import { TestClock } from 'effect/testing';
import { History, historyPoints, Ring } from './History.ts';

describe('historyPoints', () => {
  it('300 s at 1000 ms is 300, 30 s at 250 ms is 120, 1800 s at 60000 ms is 30', () => {
    assert.strictEqual(historyPoints(300, 1000), 300);
    assert.strictEqual(historyPoints(30, 250), 120);
    assert.strictEqual(historyPoints(1800, 60_000), 30);
  });
});

describe('Ring', () => {
  it('a ring keeps the newest values once full', () => {
    const ring = new Ring(3);
    assert.deepStrictEqual(ring.last(), Option.none());
    for (const v of [1, 2, 3, 4, 5]) ring.push(v);
    assert.deepStrictEqual(ring.values(), [3, 4, 5]);
    assert.deepStrictEqual(ring.last(), Option.some(5));
    assert.strictEqual(ring.length, 3);
  });
});

describe('History', () => {
  it.effect('a series created later is padded on the left with null', () =>
    Effect.gen(function* () {
      const history = new History(10, 1000);
      for (const [at, a] of [
        [1000, 1],
        [2000, 2],
        [3000, 3],
      ] as const) {
        history.tick(at);
        history.series('a').push(a);
      }
      history.series('b').push(9);
      const dump = yield* history.dump();
      assert.deepStrictEqual(dump.series, { a: [1, 2, 3], b: [null, null, 9] });
      assert.deepStrictEqual(dump.times, [1000, 2000, 3000]);
      assert.strictEqual(dump.at, 3000);
    }),
  );

  it.effect('NaN is a gap (null) in the dump', () =>
    Effect.gen(function* () {
      const history = new History(10, 1000);
      history.tick(1000);
      history.series('a').push(Number.NaN);
      history.tick(2000);
      history.series('a').push(4);
      assert.deepStrictEqual((yield* history.dump()).series, { a: [null, 4] });
    }),
  );

  it.effect("an empty history dumps at the clock's time", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(42_000);
      const dump = yield* new History(5, 250).dump();
      assert.deepStrictEqual(dump, { intervalMs: 250, capacity: 5, at: 42_000, times: [], series: {} });
    }),
  );

  it.effect('resized keeps the newest points of every series and of the times', () =>
    Effect.gen(function* () {
      const history = new History(4, 1000);
      for (const n of [1, 2, 3, 4]) {
        history.tick(n * 1000);
        history.series('a').push(n);
      }
      const resized = history.resized(2, 500);
      assert.strictEqual(resized.capacity, 2);
      assert.strictEqual(resized.intervalMs, 500);
      assert.isTrue(resized.has('a'));
      assert.deepStrictEqual(resized.keys(), ['a']);
      const dump = yield* resized.dump();
      assert.deepStrictEqual(dump.times, [3000, 4000]);
      assert.deepStrictEqual(dump.series, { a: [3, 4] });
      assert.strictEqual(dump.intervalMs, 500);
    }),
  );
});
