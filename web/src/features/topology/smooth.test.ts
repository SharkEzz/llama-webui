import { expect, test } from 'bun:test';
import { flowVisual, MAX_DT, MAX_STREAKS, Smoother } from './smooth';

test('Smoother: exponential approach, first value snaps, unknown resets to zero', () => {
  const s = new Smoother(0.5);
  expect(s.step('a', 10, 0.016)).toBe(10); // first sample: no history, take it
  let v = 10;
  for (let i = 0; i < 5; i++) v = s.step('a', 0, 0.1); // one time constant later: ~37 % left
  expect(v).toBeCloseTo(10 * Math.exp(-1), 3);
  for (let i = 0; i < 100; i++) v = s.step('a', 0, 0.1);
  expect(v).toBeCloseTo(0, 3);
  expect(s.step('b', null, 1)).toBe(0);
});

test('Smoother: a frame after a long pause eases in (dt capped), it does not jump to the target', () => {
  const s = new Smoother(0.5);
  s.step('a', 0, 0.016);
  // 30 s without a frame: counted as MAX_DT.
  expect(s.step('a', 10, 30)).toBeCloseTo(10 * (1 - Math.exp(-MAX_DT / 0.5)), 6);
  expect(s.takeMoving()).toBe(true);
});

test('flowVisual: log scale, nothing under 100 kB/s, bounded at 20 GB/s', () => {
  const none = { count: 0, speed: 0, length: 0, glow: 0 };
  expect(flowVisual(null)).toEqual(none);
  expect(flowVisual(50e3)).toEqual(none);
  const max = flowVisual(50e9);
  expect(max.count).toBe(MAX_STREAKS);
  expect(max.glow).toBe(1);
  expect(flowVisual(20e9)).toEqual(max);
});

test('flowVisual: more traffic means more streaks, longer and faster, at every decade', () => {
  const steps = [1e5, 1e6, 1e7, 1e8, 1e9, 1e10].map(flowVisual);
  expect(steps[0]!.count).toBeGreaterThan(0); // visible from the floor up
  for (let i = 1; i < steps.length; i++) {
    for (const k of ['count', 'speed', 'length', 'glow'] as const)
      expect(steps[i]![k]).toBeGreaterThan(steps[i - 1]![k]);
  }
});
