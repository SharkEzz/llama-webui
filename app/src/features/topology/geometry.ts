/*
 * The geometry of the 2D drawing: rectangles of blocks, and the route of a link as the SVG path that draws it and as
 * points sampled along it, which the streaks follow. Pure functions: the tests run without a DOM, so a path's length
 * is computed here and not asked to the browser.
 */

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A link as drawn: its SVG path, and points evenly spaced along it (the first on its start, the last on its end). */
export interface Route {
  d: string;
  points: readonly Point[];
  length: number;
}

/** Distance between two sampled points (px), about; a route has at least `MIN_INTERVALS` of them. */
const SAMPLE_PX = 9;
const MIN_INTERVALS = 6;
/** Segments a curve is flattened into before it is measured. */
const CUBIC_STEPS = 64;
const QUAD_STEPS = 16;

/** Smallest and largest scale of a drawing in its frame: under the first it scrolls, over the second it stops growing. */
export const SCALE_MIN = 0.75;
export const SCALE_MAX = 1.5;

/** A coordinate in a path: one decimal at most. */
const n = (v: number) => String(Math.round(v * 10) / 10);
const at = (pt: Point) => `${n(pt.x)} ${n(pt.y)}`;
const dist = (a: Point, b: Point) => Math.hypot(b.x - a.x, b.y - a.y);
const lerp = (a: Point, b: Point, t: number): Point => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });

/** Points evenly spaced along a polyline, its two ends included exactly. */
function sample(d: string, line: readonly Point[]): Route {
  const along = [0];
  for (let i = 1; i < line.length; i++) along.push(along[i - 1]! + dist(line[i - 1]!, line[i]!));
  const length = along.at(-1) ?? 0;
  const intervals = Math.max(MIN_INTERVALS, Math.ceil(length / SAMPLE_PX));
  const points: Point[] = [];
  let seg = 1;
  for (let k = 0; k <= intervals; k++) {
    const s = (length * k) / intervals;
    while (seg < line.length - 1 && along[seg]! < s) seg++;
    const span = along[seg]! - along[seg - 1]!;
    points.push(lerp(line[seg - 1]!, line[seg]!, span > 0 ? (s - along[seg - 1]!) / span : 0));
  }
  points[0] = line[0]!;
  points[intervals] = line.at(-1)!;
  return { d, points, length };
}

export function straight(a: Point, b: Point): Route {
  return sample(`M${at(a)} L${at(b)}`, [a, b]);
}

/** A cubic Bézier from `a` to `b`. */
export function curve(a: Point, c1: Point, c2: Point, b: Point): Route {
  const line: Point[] = [];
  for (let i = 0; i <= CUBIC_STEPS; i++) {
    const t = i / CUBIC_STEPS;
    const u = 1 - t;
    const k = [u * u * u, 3 * u * u * t, 3 * u * t * t, t * t * t] as const;
    line.push({
      x: k[0] * a.x + k[1] * c1.x + k[2] * c2.x + k[3] * b.x,
      y: k[0] * a.y + k[1] * c1.y + k[2] * c2.y + k[3] * b.y,
    });
  }
  return sample(`M${at(a)} C${at(c1)} ${at(c2)} ${at(b)}`, line);
}

/**
 * A route through `corners`, each one rounded by a quadratic curve that starts and ends `radius` px away from it, or
 * half the shorter of its two segments when they are too short for that.
 */
export function elbow(corners: readonly Point[], radius = 10): Route {
  const first = corners[0]!;
  let d = `M${at(first)}`;
  const line: Point[] = [first];
  for (let i = 1; i < corners.length; i++) {
    const c = corners[i]!;
    const next = corners[i + 1];
    const prev = corners[i - 1]!;
    const a = dist(prev, c);
    const b = next ? dist(c, next) : 0;
    const k = next ? Math.min(radius, a / 2, b / 2) : 0;
    if (!next || !(k > 0)) {
      d += ` L${at(c)}`;
      line.push(c);
      continue;
    }
    const from = lerp(c, prev, k / a);
    const to = lerp(c, next, k / b);
    d += ` L${at(from)} Q${at(c)} ${at(to)}`;
    for (let s = 0; s <= QUAD_STEPS; s++) {
      const t = s / QUAD_STEPS;
      const u = 1 - t;
      line.push({
        x: u * u * from.x + 2 * u * t * c.x + t * t * to.x,
        y: u * u * from.y + 2 * u * t * c.y + t * t * to.y,
      });
    }
  }
  return sample(d, line);
}

/** The same path, travelled from its end to its start (the lane of a link's other direction). */
export function reversed(route: Route): Route {
  return { d: route.d, points: route.points.toReversed(), length: route.length };
}

/** The two rectangles share some area, or come closer than `gap` px. */
export function overlaps(a: Rect, b: Rect, gap = 0): boolean {
  return a.x < b.x + b.w + gap && b.x < a.x + a.w + gap && a.y < b.y + b.h + gap && b.y < a.y + a.h + gap;
}

export function inside(p: Point, r: Rect): boolean {
  return p.x > r.x && p.x < r.x + r.w && p.y > r.y && p.y < r.y + r.h;
}

/** The point sits on the rectangle's outline, give or take `tolerance` px. */
export function onEdge(p: Point, r: Rect, tolerance = 1.5): boolean {
  const within =
    p.x >= r.x - tolerance && p.x <= r.x + r.w + tolerance && p.y >= r.y - tolerance && p.y <= r.y + r.h + tolerance;
  const deep =
    p.x > r.x + tolerance && p.x < r.x + r.w - tolerance && p.y > r.y + tolerance && p.y < r.y + r.h - tolerance;
  return within && !deep;
}

const side = (a: Point, b: Point, c: Point) => Math.sign((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x));

function nearSegment(p: Point, a: Point, b: Point): number {
  const len2 = (b.x - a.x) ** 2 + (b.y - a.y) ** 2;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / len2)) : 0;
  return dist(p, lerp(a, b, t));
}

/**
 * The two routes cut each other, or run on top of each other. Routes that only meet at an end (a chipset's link and
 * the links of its devices) do not cross.
 */
export function crosses(a: Route, b: Route): boolean {
  for (let i = 1; i < a.points.length; i++) {
    const a1 = a.points[i - 1]!;
    const a2 = a.points[i]!;
    for (let j = 1; j < b.points.length; j++) {
      const b1 = b.points[j - 1]!;
      const b2 = b.points[j]!;
      if (side(a1, a2, b1) * side(a1, a2, b2) < 0 && side(b1, b2, a1) * side(b1, b2, a2) < 0) return true;
      // An inner point of one lying on the other: the two run along the same line
      if (i < a.points.length - 1 && nearSegment(a2, b1, b2) < 1) return true;
      if (j < b.points.length - 1 && nearSegment(b2, a1, a2) < 1) return true;
    }
  }
  return false;
}

/** Scale at which a drawing of a natural size takes its frame, within the bounds. */
export function fitScale(frame: { w: number; h: number }, natural: { w: number; h: number }): number {
  if (!(natural.w > 0) || !(natural.h > 0)) return 1;
  return Math.max(SCALE_MIN, Math.min(SCALE_MAX, frame.w / natural.w, frame.h / natural.h));
}
