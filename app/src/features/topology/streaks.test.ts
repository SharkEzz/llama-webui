import type { TopologyLink } from '@llama-webui/shared';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { CEIL_BPS, FLOOR_BPS, type LinkFlow, REST_FLOOR_BPS } from './flows';
import { elbow, type Point, straight } from './geometry';
import {
  createStreakLoop,
  intensity,
  laneStates,
  makeLane,
  STREAK_FPS,
  STREAK_LENGTH,
  speedOf,
  streaksAt,
  trackIntensity,
} from './streaks';

const p = (x: number, y: number): Point => ({ x, y });
const link = (id: string, kind: TopologyLink['kind'] = 'pcie'): TopologyLink => ({
  id,
  from: 'cpu',
  to: id,
  kind,
  genMax: 4,
  widthMax: 4,
  genCur: 4,
  widthCur: 4,
});
const flow = (o: Partial<LinkFlow>): LinkFlow => ({
  fwdBps: null,
  backBps: null,
  activity: null,
  capacityBps: null,
  maxBps: null,
  ratio: null,
  level: 'ok',
  ...o,
});

describe('intensity', () => {
  test('a throughput under the floor, or not measured, has none', () => {
    expect(intensity(null)).toBeNull();
    expect(intensity(FLOOR_BPS - 1)).toBeNull();
    expect(intensity(Number.NaN)).toBeNull();
  });

  test('it grows on a log scale from the floor to 20 GB/s, where it stops', () => {
    expect(intensity(FLOOR_BPS)).toBe(0);
    expect(intensity(CEIL_BPS)).toBe(1);
    expect(intensity(CEIL_BPS * 10)).toBe(1);
    // 50 MiB/s stays visible next to 20 GiB/s: about half the scale
    expect(intensity(50 * 1024 ** 2)).toBeGreaterThan(0.45);
    expect(intensity(1e9)!).toBeGreaterThan(intensity(1e8)!);
    expect(speedOf(1)).toBeGreaterThan(speedOf(0));
    expect(speedOf(0)).toBe(45);
    expect(speedOf(1)).toBe(235);
  });
});

describe('makeLane', () => {
  test('a lane has room for one streak every 26 px, between 2 and 8', () => {
    expect(makeLane(straight(p(0, 0), p(300, 0)), 0).max).toBe(8);
    expect(makeLane(straight(p(0, 0), p(104, 0)), 0).max).toBe(4);
    expect(makeLane(straight(p(0, 0), p(60, 0)), 0).max).toBe(2);
  });

  test('it runs at the right of its route, along the corners too', () => {
    const lane = makeLane(straight(p(0, 10), p(100, 10)), 2.4);
    for (const pt of lane.points) expect(pt.y).toBeCloseTo(12.4, 6);
    expect(makeLane(straight(p(100, 10), p(0, 10)), 2.4).points[0]!.y).toBeCloseTo(7.6, 6);
    const bent = makeLane(elbow([p(0, 0), p(0, 50), p(80, 50)]), 2.4);
    expect(bent.points[0]!.x).toBeCloseTo(-2.4, 6);
    expect(bent.points.at(-1)!.y).toBeCloseTo(52.4, 6);
    for (const pt of bent.points) expect(Number.isFinite(pt.x + pt.y)).toBe(true);
  });

  test('a route shorter than a streak still makes a lane', () => {
    const lane = makeLane(straight(p(0, 0), p(10, 0)), 2.4);
    expect(lane.max).toBe(2);
    const streaks = streaksAt(lane, 1, 0.5);
    expect(streaks.length).toBeGreaterThan(0);
    for (const s of streaks) {
      expect(Number.isFinite(s.head.x + s.head.y + s.tail.x + s.tail.y + s.alpha)).toBe(true);
      expect(s.tail.x).toBeGreaterThanOrEqual(0);
      expect(s.head.x).toBeLessThanOrEqual(10);
    }
  });
});

describe('streaksAt', () => {
  const lane = makeLane(straight(p(0, 0), p(300, 0)), 0);

  test('more throughput puts more streaks on the lane, from one to all its slots', () => {
    expect(streaksAt(lane, 0, 0.3)).toHaveLength(1);
    expect(streaksAt(lane, 0.5, 0.3)).toHaveLength(5);
    expect(streaksAt(lane, 1, 0.3)).toHaveLength(8);
  });

  test('streaks stay spread along the lane whatever their number', () => {
    const heads = streaksAt(lane, 0.15, 0).map((s) => s.head.x);
    expect(heads).toHaveLength(2);
    expect(Math.abs(heads[0]! - heads[1]!)).toBeCloseTo(150, 6);
  });

  test('a streak is a short stroke behind its head, which travels the lane and fades at both ends', () => {
    const at = (t: number) => streaksAt(lane, 0, t)[0]!;
    expect(at(0).alpha).toBe(0);
    expect(at(0.5).alpha).toBe(1);
    expect(at(0.95).alpha).toBeCloseTo(0.5, 6);
    expect(at(0.5).head.x).toBeCloseTo(150, 6);
    expect(at(0.5).tail.x).toBeCloseTo(150 - STREAK_LENGTH, 6);
    expect(at(0.75).head.x - at(0.5).head.x).toBeCloseTo(75, 6);
    expect(at(0.01).tail.x).toBe(0);
  });
});

describe('laneStates', () => {
  const links = [link('gpu'), link('nvme'), link('igpu', 'internal')];

  test('at rest a link under 8 MiB/s has no streaks; while the server works, from the floor', () => {
    const flows = new Map([['gpu', flow({ fwdBps: 1e6, backBps: 2e5 })]]);
    expect(laneStates(links, flows, false, false).size).toBe(0);
    expect([...laneStates(links, flows, true, false).keys()]).toEqual(['gpu']);
    const busy = new Map([['gpu', flow({ fwdBps: REST_FLOOR_BPS, backBps: 2e5 })]]);
    expect([...laneStates(links, busy, false, false).keys()]).toEqual(['gpu']);
  });

  test('each measured direction has its lane, with its place on the scale and the level of the link', () => {
    const flows = new Map([
      ['gpu', flow({ fwdBps: 2e9, backBps: 5e4, level: 'warn' })],
      ['nvme', flow({ fwdBps: 3e7, backBps: 9e8 })],
    ]);
    const states = laneStates(links, flows, true, false);
    expect(states.get('gpu')).toEqual({ fwd: intensity(2e9), back: null, level: 'warn' });
    expect(states.get('nvme')).toEqual({ fwd: intensity(3e7), back: intensity(9e8), level: 'ok' });
    expect(states.get('nvme')!.back!).toBeGreaterThan(states.get('nvme')!.fwd!);
  });

  test('nothing to draw under reduced motion, without a measurement, or on an internal link', () => {
    const flows = new Map([
      ['gpu', flow({ fwdBps: 2e9, backBps: 2e9 })],
      ['nvme', flow({})],
      ['igpu', flow({ fwdBps: 2e9, backBps: 2e9 })],
    ]);
    expect(laneStates(links, flows, true, true).size).toBe(0);
    expect([...laneStates(links, flows, true, false).keys()]).toEqual(['gpu']);
    expect(laneStates(links, new Map(), true, false).size).toBe(0);
  });
});

describe('trackIntensity', () => {
  test('a track takes the intensity of its busier direction once its traffic shows', () => {
    expect(trackIntensity(link('gpu'), flow({ fwdBps: 1e6, backBps: 2e9 }), false)).toBe(intensity(2e9));
    expect(trackIntensity(link('gpu'), flow({ fwdBps: 1e6, backBps: 2e5 }), false)).toBeNull();
    expect(trackIntensity(link('gpu'), flow({ fwdBps: 1e6, backBps: 2e5 }), true)).toBe(intensity(1e6));
    expect(trackIntensity(link('gpu'), undefined, true)).toBeNull();
    expect(trackIntensity(link('igpu', 'internal'), flow({ fwdBps: 2e9 }), true)).toBeNull();
  });

  test('a memory link without a measurement follows the CPU activity', () => {
    expect(trackIntensity(link('ram', 'memory'), flow({ activity: 40 }), false)).toBe(0.4);
    expect(trackIntensity(link('ram', 'memory'), flow({ activity: 250 }), false)).toBe(1);
    expect(trackIntensity(link('ram', 'memory'), flow({ fwdBps: 1e9, backBps: 3e9 }), false)).toBe(intensity(3e9));
  });
});

describe('the streak loop', () => {
  const calls: string[] = [];
  const ctx = {
    clearRect: () => calls.push('clear'),
    beginPath: () => {},
    moveTo: () => {},
    lineTo: () => {},
    stroke: () => calls.push('stroke'),
    setTransform: () => {},
    strokeStyle: '',
    globalAlpha: 1,
    lineWidth: 0,
    lineCap: 'butt',
  };
  const canvas = { width: 0, height: 0, getContext: () => ctx } as unknown as HTMLCanvasElement;
  const geo = [{ id: 'gpu', route: straight(p(0, 0), p(300, 0)), badge: null }];
  const on = new Map([['gpu', { fwd: 1, back: null, level: 'ok' as const }]]);
  const frame = 1000 / STREAK_FPS;

  beforeEach(() => {
    vi.useFakeTimers();
    calls.length = 0;
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test('draws at 20 frames per second while a link has streaks', () => {
    const loop = createStreakLoop(canvas);
    loop.resize(400, 100, 2);
    expect([canvas.width, canvas.height]).toEqual([800, 200]);
    loop.setLinks(geo);
    expect(loop.running).toBe(false);
    loop.setStates(on, () => 'red');
    expect(loop.running).toBe(true);
    vi.advanceTimersByTime(frame * 20);
    expect(calls.filter((c) => c === 'clear')).toHaveLength(20);
    expect(calls.filter((c) => c === 'stroke')).toHaveLength(20 * 8);
    expect(ctx.strokeStyle).toBe('red');
    loop.stop();
    expect(loop.running).toBe(false);
  });

  test('clears the canvas once and stops when nothing flows any more', () => {
    const loop = createStreakLoop(canvas);
    loop.setLinks(geo);
    loop.setStates(on, () => 'red');
    vi.advanceTimersByTime(frame * 3);
    calls.length = 0;
    loop.setStates(new Map(), () => 'red');
    vi.advanceTimersByTime(frame * 10);
    expect(calls).toEqual(['clear']);
    expect(loop.running).toBe(false);
    // And starts again with the next traffic
    loop.setStates(on, () => 'red');
    vi.advanceTimersByTime(frame);
    expect(calls.filter((c) => c === 'stroke')).toHaveLength(8);
    loop.stop();
  });

  test('never starts for a link the drawing does not have', () => {
    const loop = createStreakLoop(canvas);
    loop.setLinks(geo);
    loop.setStates(new Map([['other', { fwd: 1, back: 1, level: 'ok' as const }]]), () => 'red');
    expect(loop.running).toBe(false);
    vi.advanceTimersByTime(frame * 5);
    expect(calls).toEqual([]);
  });

  test('a canvas without a 2D context draws nothing and does not throw', () => {
    const loop = createStreakLoop({ width: 0, height: 0, getContext: () => null } as unknown as HTMLCanvasElement);
    loop.resize(100, 100, 1);
    loop.setLinks(geo);
    loop.setStates(on, () => 'red');
    expect(loop.running).toBe(false);
  });
});
