import type { HistoryDump } from '@llama-webui/shared';
import { Ring } from './ring';

/** Points of a `historySeconds` history sampled every `intervalMs`. */
export const historyPoints = (historySeconds: number, intervalMs: number) =>
  Math.ceil((historySeconds * 1000) / intervalMs);

/**
 * Named rings of the same capacity (copied from llama-tui) + the ring of each tick's timestamp.
 * Every series moves one point per tick once created (NaN = gap), so a series shorter than the
 * timestamps started later: dump() pads it on the left with gaps.
 */
export class History {
  private rings = new Map<string, Ring>();
  private times: Ring;

  constructor(
    readonly capacity: number,
    readonly intervalMs: number,
  ) {
    this.times = new Ring(capacity);
  }

  /** Same series over `capacity` points (the most recent kept), at the `intervalMs` interval. */
  resized(capacity: number, intervalMs = this.intervalMs): History {
    const h = new History(capacity, intervalMs);
    h.times = Ring.of(this.times.values(), capacity);
    for (const [key, ring] of this.rings) h.rings.set(key, Ring.of(ring.values(), capacity));
    return h;
  }

  /** New tick at time `at`. */
  tick(at: number): void {
    this.times.push(at);
  }

  series(key: string): Ring {
    let r = this.rings.get(key);
    if (!r) {
      r = new Ring(this.capacity);
      this.rings.set(key, r);
    }
    return r;
  }

  has(key: string): boolean {
    return this.rings.has(key);
  }

  keys(): string[] {
    return [...this.rings.keys()];
  }

  dump(): HistoryDump {
    const times = this.times.values();
    const series: Record<string, (number | null)[]> = {};
    for (const [key, ring] of this.rings) {
      const values = ring.values().slice(-times.length);
      const pad: null[] = new Array(times.length - values.length).fill(null);
      series[key] = [...pad, ...values.map((v) => (Number.isFinite(v) ? v : null))];
    }
    return { intervalMs: this.intervalMs, capacity: this.capacity, at: times.at(-1) ?? Date.now(), times, series };
  }
}
