import { expect, test } from 'bun:test';
import { FramePacer } from './pacing';

/** Rendered frames per second over `secs` of rAF ticks at `hz`, `during` setting the flags of each frame. */
function fps(p: FramePacer, hz: number, secs: number, during: (p: FramePacer, now: number) => void): number {
  let frames = 0;
  const start = 10_000;
  for (let i = 0; i < hz * secs; i++) {
    const now = start + (i * 1000) / hz;
    if (!p.shouldRender(now)) continue;
    frames++;
    during(p, now);
    p.rendered(now, false);
  }
  return frames / secs;
}

test('FramePacer: something animating renders at 60 fps whatever the display rate', () => {
  for (const hz of [60, 120, 144]) {
    const rate = fps(new FramePacer(), hz, 2, (p) => {
      p.active = true;
    });
    expect(rate).toBeGreaterThanOrEqual(hz === 144 ? 70 : 59.5);
    expect(rate).toBeLessThanOrEqual(hz === 144 ? 72.5 : 60.5); // 144 Hz: every other frame
  }
});

test('FramePacer: camera drift alone renders at 20 fps; a still scene stops after its first frame', () => {
  expect(
    fps(new FramePacer(), 120, 2, (p) => {
      p.drift = true;
    }),
  ).toBe(20);
  expect(fps(new FramePacer(), 120, 2, () => {})).toBe(0.5); // the requested first frame only
});

test('FramePacer: a request or a gesture brings frames back, and damping keeps them a while after it', () => {
  const p = new FramePacer();
  p.rendered(0, false);
  expect(p.shouldRender(1000)).toBe(false);
  p.requested = true;
  expect(p.shouldRender(1000)).toBe(true);
  p.rendered(1000, false);
  // A value still easing towards its target (smoother) keeps the full rate.
  p.rendered(1016.7, true);
  expect(p.shouldRender(1033.4)).toBe(true);
  p.rendered(1033.4, false);
  expect(p.shouldRender(1050)).toBe(false);

  p.interacting = true;
  expect(p.shouldRender(1050.1)).toBe(true);
  p.rendered(1050.1, false);
  p.interacting = false;
  p.hold(1060, 1000);
  expect(p.shouldRender(1070)).toBe(true);
  p.rendered(1070, false);
  expect(p.shouldRender(2100)).toBe(false);
});
