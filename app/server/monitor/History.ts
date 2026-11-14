import type { HistoryDump } from '@llama-webui/shared';
import { Array as Arr, Clock, Effect, Option } from 'effect';
import { dual } from 'effect/Function';

/** Points of a `historySeconds` history sampled every `intervalMs`. */
export const historyPoints: {
  (intervalMs: number): (historySeconds: number) => number;
  (historySeconds: number, intervalMs: number): number;
} = dual(2, (historySeconds: number, intervalMs: number): number => Math.ceil((historySeconds * 1000) / intervalMs));

/**
 * Fixed-capacity ring of numbers (NaN allowed: a gap). Mutable on purpose: the monitor pushes one value per series
 * per tick.
 */
export class Ring {
  readonly capacity: number;
  private readonly buf: Array<number>;
  private start = 0;
  private size = 0;

  constructor(capacity: number) {
    this.capacity = capacity;
    this.buf = new Array<number>(capacity).fill(0);
  }

  /** A ring of `capacity` holding the newest of these values. */
  static of(values: ReadonlyArray<number>, capacity: number): Ring {
    const ring = new Ring(capacity);
    for (const v of Arr.takeRight(values, capacity)) ring.push(v);
    return ring;
  }

  push(v: number): void {
    this.buf[(this.start + this.size) % this.capacity] = v;
    if (this.size < this.capacity) this.size++;
    else this.start = (this.start + 1) % this.capacity;
  }

  /** The values, oldest first. */
  values(): ReadonlyArray<number> {
    return Array.from({ length: this.size }, (_, i) => this.buf[(this.start + i) % this.capacity] ?? 0);
  }

  last(): Option.Option<number> {
    return this.size === 0
      ? Option.none()
      : Option.fromNullishOr(this.buf[(this.start + this.size - 1) % this.capacity]);
  }

  get length(): number {
    return this.size;
  }
}

/**
 * Named rings of one capacity plus the ring of each tick's time. Every series moves one point per tick once created
 * (NaN = gap), so a series shorter than the times started later: `dump` pads it on the left with gaps.
 */
export class History {
  readonly capacity: number;
  readonly intervalMs: number;
  private readonly rings = new Map<string, Ring>();
  private times: Ring;

  constructor(capacity: number, intervalMs: number) {
    this.capacity = capacity;
    this.intervalMs = intervalMs;
    this.times = new Ring(capacity);
  }

  /** The same series over `capacity` points (the newest kept), at the `intervalMs` interval. */
  resized(capacity: number, intervalMs: number): History {
    const history = new History(capacity, intervalMs);
    history.times = Ring.of(this.times.values(), capacity);
    for (const [key, ring] of this.rings) history.rings.set(key, Ring.of(ring.values(), capacity));
    return history;
  }

  /** A new tick at time `at`. */
  tick(at: number): void {
    this.times.push(at);
  }

  /** The ring of a series, created empty on first use. */
  series(key: string): Ring {
    const existing = this.rings.get(key);
    if (existing !== undefined) return existing;
    const ring = new Ring(this.capacity);
    this.rings.set(key, ring);
    return ring;
  }

  has(key: string): boolean {
    return this.rings.has(key);
  }

  keys(): ReadonlyArray<string> {
    return Array.from(this.rings.keys());
  }

  /** Every series over the times, oldest first, `null` for a gap; `at` is the last tick, else the clock's time. */
  dump(): Effect.Effect<HistoryDump> {
    const times = this.times.values();
    const series: Record<string, ReadonlyArray<number | null>> = {};
    for (const [key, ring] of this.rings) {
      const values = Arr.map(Arr.takeRight(ring.values(), times.length), (v) => (Number.isFinite(v) ? v : null));
      series[key] = [...new Array<null>(times.length - values.length).fill(null), ...values];
    }
    return Option.match(Arr.last(times), {
      onSome: (at) => Effect.succeed(at),
      onNone: () => Clock.currentTimeMillis,
    }).pipe(Effect.map((at) => ({ intervalMs: this.intervalMs, capacity: this.capacity, at, times, series })));
  }
}
