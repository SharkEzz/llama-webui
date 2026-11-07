import type { HistoryDump } from '@llama-webui/shared';
import { Ring } from './ring';

/** Points d'un historique de `historySeconds` échantillonné toutes les `intervalMs`. */
export const historyPoints = (historySeconds: number, intervalMs: number) =>
  Math.ceil((historySeconds * 1000) / intervalMs);

/**
 * Anneaux nommés de même capacité (copié de llama-tui) + l'anneau des instants de chaque tick.
 * Toutes les séries avancent d'un point par tick une fois créées (NaN = trou), donc une série plus courte
 * que les instants commence plus tard : elle est complétée à gauche par des trous dans dump().
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

  /** Mêmes séries sur `capacity` points (les plus récents gardés), à la cadence `intervalMs`. */
  resized(capacity: number, intervalMs = this.intervalMs): History {
    const h = new History(capacity, intervalMs);
    h.times = Ring.of(this.times.values(), capacity);
    for (const [key, ring] of this.rings) h.rings.set(key, Ring.of(ring.values(), capacity));
    return h;
  }

  /** Nouveau tick à l'instant `at`. */
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
