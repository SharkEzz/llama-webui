import type { TopologyLink } from '@llama-webui/shared';
import { CEIL_BPS, FLOOR_BPS, type Level, type LinkFlow, linkShown } from './flows';
import { type Point, reversed, type Route } from './geometry';
import type { LinkGeo } from './tree';

/*
 * The streaks that run along a link while it carries traffic: a pure model (where a throughput sits on the scale, what
 * a lane shows at a given time) and the loop that draws it on the view's one canvas. The loop is the only script of
 * the drawing that runs between two samples; it stops, canvas cleared, as soon as no link has streaks to show.
 */

export const STREAK_FPS = 20;
/** Length of a streak (px of the drawing). */
export const STREAK_LENGTH = 12;
/** Room one streak takes on a lane (px), and the bounds of a lane's slots. */
const STREAK_ROOM = 26;
const MIN_SLOTS = 2;
const MAX_SLOTS = 8;
/** Share of a traverse over which a streak fades in, then out. */
const FADE = 0.1;
/** Distance between a link's two lanes and its middle (px): one direction on each side. */
const LANE_SIDE = 2.4;
/** Longest step of the animation (s): a tab coming back from the background does not make the streaks jump. */
const MAX_DT = 0.1;
const RANGE = Math.log10(CEIL_BPS / FLOOR_BPS);

/**
 * Place of a throughput on the log scale from the floor to 20 GB/s (0..1): 50 MiB/s must stay visible next to
 * 20 GiB/s. Null under the floor or without a measurement: nothing to show.
 */
export function intensity(bps: number | null): number | null {
  if (bps === null || !(bps >= FLOOR_BPS)) return null;
  return Math.min(1, Math.log10(bps / FLOOR_BPS) / RANGE);
}

/** Speed of a streak (px/s) for an intensity. */
export const speedOf = (x: number) => 45 + 190 * x;

export interface Lane {
  /** Evenly spaced points, in the direction of travel. */
  points: readonly Point[];
  length: number;
  /** Slots a streak can take. */
  max: number;
  /** Order the slots fill in, by slot: any first few of them are evenly spread along the lane. */
  rank: readonly number[];
}

/** For n slots, the rank at which each one fills (0, n/2, n/4, 3n/4…). */
function spreadOrder(n: number): number[] {
  const bits = Math.max(1, Math.ceil(Math.log2(n)));
  const rev = (i: number) => {
    let r = 0;
    for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
    return r;
  };
  const order = Array.from({ length: n }, (_, i) => i).toSorted((a, b) => rev(a) - rev(b));
  const rank: number[] = [];
  for (const [k, slot] of order.entries()) rank[slot] = k;
  return rank;
}

/** One direction of a link: the route, already in the direction of travel, shifted `side` px to its right. */
export function makeLane(route: Route, side: number): Lane {
  const pts = route.points;
  const points = pts.map((pt, i) => {
    const a = pts[Math.max(0, i - 1)]!;
    const b = pts[Math.min(pts.length - 1, i + 1)]!;
    const angle = Math.atan2(b.y - a.y, b.x - a.x);
    return { x: pt.x - Math.sin(angle) * side, y: pt.y + Math.cos(angle) * side };
  });
  const max = Math.max(MIN_SLOTS, Math.min(MAX_SLOTS, Math.round(route.length / STREAK_ROOM)));
  return { points, length: route.length, max, rank: spreadOrder(max) };
}

function pointAt(lane: Lane, distance: number): Point {
  const n = lane.points.length - 1;
  const f = lane.length > 0 ? Math.max(0, Math.min(n, (distance / lane.length) * n)) : 0;
  const i = Math.min(n - 1, Math.floor(f));
  const a = lane.points[i]!;
  const b = lane.points[i + 1]!;
  return { x: a.x + (b.x - a.x) * (f - i), y: a.y + (b.y - a.y) * (f - i) };
}

export interface Streak {
  tail: Point;
  head: Point;
  /** 0..1: a streak fades in as it leaves and out as it arrives. */
  alpha: number;
}

/** The streaks of a lane for an intensity `x` (0..1), at progress `t` of a traverse (0..1). */
export function streaksAt(lane: Lane, x: number, t: number): Streak[] {
  const count = Math.round(1 + (lane.max - 1) * x);
  const out: Streak[] = [];
  for (let i = 0; i < lane.max; i++) {
    if (lane.rank[i]! >= count) continue;
    const u = (t + i / lane.max) % 1;
    const s = u * lane.length;
    out.push({
      head: pointAt(lane, s),
      tail: pointAt(lane, s - STREAK_LENGTH),
      alpha: Math.min(1, u / FADE, (1 - u) / FADE),
    });
  }
  return out;
}

export interface LaneState {
  /** Intensity of each direction (0..1): `fwd` runs from the link's upstream block; null: no streak that way. */
  fwd: number | null;
  back: number | null;
  level: Level;
}

/**
 * The links that have streaks to draw, by link id. None for a link whose traffic is not worth showing (see
 * `linkShown`), for an internal connection, or under reduced motion: an empty map stops the loop.
 */
export function laneStates(
  links: readonly TopologyLink[],
  flows: Map<string, LinkFlow>,
  busy: boolean,
  reducedMotion: boolean,
): Map<string, LaneState> {
  const out = new Map<string, LaneState>();
  if (reducedMotion) return out;
  for (const l of links) {
    const flow = flows.get(l.id);
    if (!flow || l.kind === 'internal' || !linkShown(flow, busy)) continue;
    const fwd = intensity(flow.fwdBps);
    const back = intensity(flow.backBps);
    if (fwd !== null || back !== null) out.set(l.id, { fwd, back, level: flow.level });
  }
  return out;
}

/**
 * How strongly a link's track is drawn (0..1), null for a track at rest. A memory link without a bandwidth
 * measurement follows the CPU activity instead: it has no streaks, since nothing says which way the bytes go.
 */
export function trackIntensity(link: TopologyLink, flow: LinkFlow | undefined, busy: boolean): number | null {
  if (!flow || link.kind === 'internal') return null;
  if (flow.activity !== null) return Math.max(0, Math.min(1, flow.activity / 100));
  if (!linkShown(flow, busy)) return null;
  return intensity(Math.max(flow.fwdBps ?? 0, flow.backBps ?? 0));
}

export interface StreakLoop {
  /** The links of the drawing: their lanes replace the previous ones, and carry on with what flowed. */
  setLinks: (links: readonly LinkGeo[]) => void;
  /** What flows now; `colorOf` gives a link's stroke, as a color a canvas reads. Starts the timer when needed. */
  setStates: (states: Map<string, LaneState>, colorOf: (id: string, level: Level) => string) => void;
  /** Size of the drawing (px of its natural size) and the ratio of canvas pixels to them (scale × pixel ratio). */
  resize: (width: number, height: number, ratio: number) => void;
  stop: () => void;
  readonly running: boolean;
}

interface Running {
  lane: Lane;
  x: number;
  color: string;
  /** Progress of a traverse (0..1), kept from one frame to the next. */
  t: number;
}

/** Draws the streaks on `canvas`, with one timer that only runs while a link has streaks. */
export function createStreakLoop(canvas: HTMLCanvasElement): StreakLoop {
  const ctx = canvas.getContext('2d');
  let lanes = new Map<string, { fwd: Lane; back: Lane }>();
  /** Progress of each lane, by `<link id>:<direction>`: kept across samples so a streak never jumps. */
  const progress = new Map<string, number>();
  let active: (Running & { key: string })[] = [];
  let size = { width: 0, height: 0, ratio: 1 };
  let timer: ReturnType<typeof setInterval> | null = null;
  let last = 0;
  let dirty = false;

  const halt = () => {
    if (timer !== null) clearInterval(timer);
    timer = null;
  };
  const frame = () => {
    if (!ctx) return;
    const now = performance.now();
    const dt = Math.min(MAX_DT, Math.max(0, (now - last) / 1000));
    last = now;
    ctx.clearRect(0, 0, size.width, size.height);
    dirty = active.length > 0;
    for (const lane of active) {
      lane.t = (lane.t + (dt * speedOf(lane.x)) / Math.max(1, lane.lane.length)) % 1;
      progress.set(lane.key, lane.t);
      ctx.strokeStyle = lane.color;
      for (const s of streaksAt(lane.lane, lane.x, lane.t)) {
        ctx.globalAlpha = s.alpha;
        ctx.beginPath();
        ctx.moveTo(s.tail.x, s.tail.y);
        ctx.lineTo(s.head.x, s.head.y);
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
    // The frame that drew nothing has cleared the canvas: nothing left to do until the next traffic
    if (!dirty) halt();
  };
  const style = () => {
    if (!ctx) return;
    ctx.setTransform(size.ratio, 0, 0, size.ratio, 0, 0);
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
  };

  let states = new Map<string, LaneState>();
  let colorOf: (id: string, level: Level) => string = () => '';
  /** The lanes that have streaks now, from the last states and the current links; starts the timer when needed. */
  const apply = () => {
    active = [];
    for (const [id, state] of states) {
      const pair = lanes.get(id);
      if (!pair) continue;
      const color = colorOf(id, state.level);
      for (const dir of ['fwd', 'back'] as const) {
        const x = state[dir];
        if (x === null) continue;
        const key = `${id}:${dir}`;
        // A lane that starts takes a place of its own, so the lanes of a drawing do not pulse together
        const t = progress.get(key) ?? (active.length * 0.37) % 1;
        active.push({ key, lane: pair[dir], x, color, t });
      }
    }
    if (ctx && timer === null && (active.length > 0 || dirty)) {
      last = performance.now();
      timer = setInterval(frame, 1000 / STREAK_FPS);
    }
  };

  return {
    setLinks(links) {
      lanes = new Map(
        links.map((l) => [l.id, { fwd: makeLane(l.route, LANE_SIDE), back: makeLane(reversed(l.route), LANE_SIDE) }]),
      );
      apply();
    },
    setStates(next, color) {
      states = next;
      colorOf = color;
      apply();
    },
    resize(width, height, ratio) {
      size = { width, height, ratio };
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
      // Sizing a canvas resets its context, and clears it: the next frame redraws
      style();
    },
    stop() {
      halt();
      active = [];
      states = new Map();
    },
    get running() {
      return timer !== null;
    },
  };
}
