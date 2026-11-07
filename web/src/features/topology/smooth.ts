/** Distance to the target below which a smoothed value has arrived (invisible: less than one 8-bit color level). */
const SETTLED = 2e-3;
/**
 * Maximum time step (s) of a frame. The scene may go without frames (nothing moves): the next one then arrives with a
 * `dt` spanning the whole pause, which would make the value jump to its target instead of easing toward it.
 */
export const MAX_DT = 0.1;

/** Per-key exponential smoothing, so tick values (1 s) do not advance in jumps in the render loop. */
export class Smoother {
  private v = new Map<string, number>();
  private moving = false;

  /** `tau`: time constant (s); after `tau`, 63% of the way to the target is covered. */
  constructor(private readonly tau = 0.35) {}

  step(key: string, target: number | null, dt: number): number {
    const t = target ?? 0;
    const prev = this.v.get(key);
    if (prev === undefined) {
      this.v.set(key, t);
      return t;
    }
    const next = prev + (t - prev) * (1 - Math.exp(-Math.min(dt, MAX_DT) / this.tau));
    this.v.set(key, next);
    if (Math.abs(t - next) > SETTLED) this.moving = true;
    return next;
  }

  /** A value had not yet reached its target since the last call: the animation must go on. */
  takeMoving(): boolean {
    const m = this.moving;
    this.moving = false;
    return m;
  }
}

const FLOOR_BPS = 1e5;
const CEIL_BPS = 20e9;
const RANGE = Math.log10(CEIL_BPS / FLOOR_BPS);
export const MAX_PARTICLES = 64;

/**
 * Maps a throughput to visual parameters, on a log scale: 50 MiB/s must stay visible next to 20 GiB/s.
 * `particles`: number of particles on the link; `speed`: fraction of the link covered per second; `glow`: 0..1.
 */
export function flowVisual(bps: number | null): { particles: number; speed: number; glow: number } {
  if (bps === null || !(bps >= FLOOR_BPS)) return { particles: 0, speed: 0, glow: 0 };
  const x = Math.min(1, Math.log10(bps / FLOOR_BPS) / RANGE);
  return { particles: Math.round(4 + (MAX_PARTICLES - 4) * x), speed: 0.15 + 0.6 * x, glow: 0.15 + 0.85 * x };
}
