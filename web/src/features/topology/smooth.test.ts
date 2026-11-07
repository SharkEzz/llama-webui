import { expect, test } from 'bun:test';
import { flowVisual, Smoother } from './smooth';

test('Smoother: exponential approach, first value snaps, unknown resets to zero', () => {
  const s = new Smoother(0.5);
  expect(s.step('a', 10, 0.016)).toBe(10); // first sample: no history, take it
  const v = s.step('a', 0, 0.5); // one time constant later: ~37 % left
  expect(v).toBeCloseTo(10 * Math.exp(-1), 3);
  expect(s.step('a', 0, 10)).toBeCloseTo(0, 3);
  expect(s.step('b', null, 1)).toBe(0);
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
