import { expect, test } from 'vitest';
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
  expect(s.takeMoving()).toBe('active');
});

test('Smoother: the easing follows time, not frames: 30 fps and 60 fps draw the same curve', () => {
  const at30 = new Smoother(0.4);
  const at60 = new Smoother(0.4);
  at30.step('a', 0, 1 / 30);
  at60.step('a', 0, 1 / 60);
  for (let frame = 1; frame <= 75; frame++) {
    const slow = at30.step('a', 10, 1 / 30);
    at60.step('a', 10, 1 / 60);
    const fast = at60.step('a', 10, 1 / 60);
    expect(slow).toBeCloseTo(fast, 9);
  }
});

test('Smoother: a streak parameter still easing alone only needs the ambient rate', () => {
  const s = new Smoother(0.4);
  s.step('lane:n', 3, 1 / 30);
  s.step('lane:n', 20, 1 / 30, 'ambient');
  expect(s.takeMoving()).toBe('ambient');
  // Reported once: the next frame starts again from nothing.
  expect(s.takeMoving()).toBe(false);
});

test('Smoother: an easing glow needs the active rate, also next to an easing streak parameter', () => {
  const s = new Smoother(0.4);
  s.step('link:glow', 0.1, 1 / 60);
  s.step('lane:n', 3, 1 / 60);
  s.step('link:glow', 0.9, 1 / 60);
  expect(s.takeMoving()).toBe('active');
  // Whatever the order of the keys within the frame.
  s.step('link:glow', 0.9, 1 / 60);
  s.step('lane:n', 20, 1 / 60, 'ambient');
  expect(s.takeMoving()).toBe('active');
  s.step('lane:n', 20, 1 / 60, 'ambient');
  s.step('link:glow', 0.9, 1 / 60);
  expect(s.takeMoving()).toBe('active');
});

test('Smoother: nothing easing (values at their targets) reports no motion', () => {
  const s = new Smoother(0.4);
  s.step('link:glow', 0.5, 1 / 60);
  s.step('lane:n', 12, 1 / 60, 'ambient');
  s.step('link:glow', 0.5, 1 / 60);
  s.step('lane:n', 12, 1 / 60, 'ambient');
  expect(s.takeMoving()).toBe(false);
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
