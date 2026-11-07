import { expect, test } from 'bun:test';
import { flowVisual, MAX_DT, Smoother } from './smooth';

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
  expect(flowVisual(null)).toEqual({ particles: 0, speed: 0, glow: 0 });
  expect(flowVisual(50e3)).toEqual({ particles: 0, speed: 0, glow: 0 });
  const slow = flowVisual(10e6);
  const fast = flowVisual(2e9);
  const max = flowVisual(50e9);
  expect(slow.particles).toBeGreaterThan(0);
  expect(fast.particles).toBeGreaterThan(slow.particles);
  expect(fast.speed).toBeGreaterThan(slow.speed);
  expect(max.particles).toBeLessThanOrEqual(64);
  expect(max.glow).toBeLessThanOrEqual(1);
  expect(flowVisual(20e9)).toEqual(max);
});
