import { describe, expect, test } from 'vitest';
import {
  crosses,
  curve,
  elbow,
  fitScale,
  inside,
  join,
  onEdge,
  overlaps,
  type Point,
  type Route,
  reversed,
  SCALE_MAX,
  SCALE_MIN,
  straight,
} from './geometry';

const p = (x: number, y: number): Point => ({ x, y });
const steps = (r: Route) => r.points.slice(1).map((b, i) => Math.hypot(b.x - r.points[i]!.x, b.y - r.points[i]!.y));

describe('routes', () => {
  test('a straight route is its segment, sampled evenly from one end to the other', () => {
    const r = straight(p(0, 0), p(100, 0));
    expect(r.d).toBe('M0 0 L100 0');
    expect(r.length).toBeCloseTo(100, 6);
    expect(r.points[0]).toEqual(p(0, 0));
    expect(r.points.at(-1)).toEqual(p(100, 0));
    expect(r.points.length).toBeGreaterThanOrEqual(7);
    for (const s of steps(r)) expect(s).toBeCloseTo(r.length / (r.points.length - 1), 6);
  });

  test('a route shorter than a sample still has its two ends, and at least six intervals', () => {
    const r = straight(p(5, 5), p(5, 15));
    expect(r.length).toBeCloseTo(10, 6);
    expect(r.points).toHaveLength(7);
    expect(r.points.at(-1)).toEqual(p(5, 15));
  });

  test('a curve is longer than its chord, ends on its ends and is sampled evenly', () => {
    const r = curve(p(0, 0), p(0, 80), p(200, 20), p(200, 100));
    expect(r.d).toBe('M0 0 C0 80 200 20 200 100');
    expect(r.length).toBeGreaterThan(Math.hypot(200, 100));
    expect(r.points[0]).toEqual(p(0, 0));
    expect(r.points.at(-1)).toEqual(p(200, 100));
    const each = r.length / (r.points.length - 1);
    for (const s of steps(r)) expect(Math.abs(s - each) / each).toBeLessThan(0.01);
  });

  test('an elbow rounds its corners, and its length counts the arcs', () => {
    const corners = [p(0, 0), p(0, 50), p(80, 50)];
    expect(elbow(corners, 0).length).toBeCloseTo(130, 6);
    expect(elbow(corners, 0).d).toBe('M0 0 L0 50 L80 50');
    // A quadratic corner of radius 10 replaces 20 px of straight line by about 16.2 px of curve
    const round = elbow(corners, 10);
    expect(round.length).toBeGreaterThan(125);
    expect(round.length).toBeLessThan(127.5);
    expect(round.d).toBe('M0 0 L0 40 Q0 50 10 50 L80 50');
    expect(round.points.at(-1)).toEqual(p(80, 50));
  });

  test('a corner between segments shorter than twice the radius shrinks instead of overshooting', () => {
    const r = elbow([p(0, 0), p(0, 8), p(80, 8)], 10);
    expect(r.d).toBe('M0 0 L0 4 Q0 8 4 8 L80 8');
    for (const pt of r.points) {
      expect(pt.y).toBeGreaterThanOrEqual(0);
      expect(pt.y).toBeLessThanOrEqual(8.001);
    }
  });

  test('two routes joined end to end are one route', () => {
    const drop = straight(p(0, 0), p(0, 50));
    const bend = curve(p(0, 50), p(0, 90), p(120, 60), p(120, 100));
    const both = join(drop, bend);
    expect(both.d).toBe('M0 0 L0 50 C0 90 120 60 120 100');
    expect(Math.abs(both.length - (drop.length + bend.length))).toBeLessThan(1);
    expect(both.points[0]).toEqual(p(0, 0));
    expect(both.points.at(-1)).toEqual(p(120, 100));
    expect(() => join(drop, straight(p(5, 5), p(9, 9)))).toThrow('do not meet');
  });

  test('a reversed route runs the same path the other way', () => {
    const r = elbow([p(0, 0), p(0, 50), p(80, 50)]);
    const back = reversed(r);
    const { length } = back;
    expect(length).toBe(r.length);
    expect(back.points).toEqual(r.points.toReversed());
    expect(back.d).toBe(r.d);
  });
});

describe('rectangles', () => {
  const a = { x: 0, y: 0, w: 100, h: 50 };

  test('rectangles that touch do not overlap, unless a gap is asked between them', () => {
    expect(overlaps(a, { x: 100, y: 0, w: 50, h: 50 })).toBe(false);
    expect(overlaps(a, { x: 100, y: 0, w: 50, h: 50 }, 8)).toBe(true);
    expect(overlaps(a, { x: 108, y: 0, w: 50, h: 50 }, 8)).toBe(false);
    expect(overlaps(a, { x: 99, y: 49, w: 50, h: 50 })).toBe(true);
    expect(overlaps(a, { x: 20, y: 60, w: 10, h: 10 })).toBe(false);
  });

  test('a point is inside a rectangle strictly, and on its edge within a tolerance', () => {
    expect(inside(p(50, 25), a)).toBe(true);
    expect(inside(p(100, 25), a)).toBe(false);
    expect(inside(p(50, -1), a)).toBe(false);
    expect(onEdge(p(100, 25), a)).toBe(true);
    expect(onEdge(p(50, 51), a)).toBe(true);
    expect(onEdge(p(50, 53), a)).toBe(false);
    expect(onEdge(p(50, 25), a)).toBe(false);
    expect(onEdge(p(120, 50), a)).toBe(false);
  });
});

describe('crossings', () => {
  test('two routes that cut each other cross', () => {
    expect(crosses(straight(p(0, 0), p(100, 100)), straight(p(0, 100), p(100, 0)))).toBe(true);
    expect(crosses(elbow([p(0, 0), p(0, 50), p(80, 50)]), straight(p(40, 0), p(40, 100)))).toBe(true);
  });

  test('parallel routes, and routes that only share an end, do not', () => {
    expect(crosses(straight(p(0, 0), p(100, 0)), straight(p(0, 10), p(100, 10)))).toBe(false);
    expect(crosses(straight(p(0, 0), p(100, 0)), straight(p(100, 0), p(100, 80)))).toBe(false);
  });
});

describe('fitScale', () => {
  const natural = { w: 2000, h: 1000 };

  test('the drawing takes its frame, between the two bounds', () => {
    expect(fitScale({ w: 2000, h: 1000 }, natural)).toBe(1);
    expect(fitScale({ w: 2400, h: 1100 }, natural)).toBeCloseTo(1.1, 6);
    expect(fitScale({ w: 4000, h: 2000 }, natural)).toBe(SCALE_MAX);
    expect(fitScale({ w: 1000, h: 500 }, natural)).toBe(SCALE_MIN);
  });

  test('a drawing shrinks to its frame down to half its size, and grows up to twice', () => {
    expect(fitScale({ w: 1200, h: 900 }, natural)).toBeCloseTo(0.6, 6);
    expect(fitScale({ w: 3600, h: 1900 }, natural)).toBeCloseTo(1.8, 6);
    expect(fitScale({ w: 600, h: 600 }, natural)).toBe(0.5);
    expect(fitScale({ w: 9000, h: 9000 }, natural)).toBe(2);
  });

  test('a frame not measured yet, or an empty drawing, gives a usable scale', () => {
    expect(fitScale({ w: 0, h: 0 }, natural)).toBe(SCALE_MIN);
    expect(fitScale({ w: 800, h: 600 }, { w: 0, h: 0 })).toBe(1);
  });
});
