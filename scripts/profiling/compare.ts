// Two runs compared figure by figure: the difference, and whether it exceeds the noise of its kind.
import { type Figure, type FigureKind, figures, windowsOf } from './figures.ts';
import { RESULTS_VERSION, type Results, SCENARIO_NAMES, type ScenarioName } from './results.ts';

/**
 * The noise of each kind of figure: a difference is a change when it exceeds both the absolute floor and the share
 * of the reference. `gpuBusy` (the AMD cards' gauge) is indicative and never a change.
 */
export const NOISE: Record<FigureKind, { relative: number; absolute: number } | null> = {
  // Calibrated on two runs of `dashboard aurora` on unchanged code (check-1, check-2, 2026-11-22), the measured spread in
  // each comment.
  // percentage points: up to 1.15 for a process (in a traced window; 0.8 in the others)
  cpu: { relative: 0, absolute: 1.5 },
  // percentage points: up to 0.77 (page tasks of a traced window)
  share: { relative: 0, absolute: 1 },
  tps: { relative: 0.01, absolute: 0 },
  // ms: up to 11.8 % (the page profile's active time)
  duration: { relative: 0.15, absolute: 1 },
  // bytes: up to 8.6 % (the JS heap, read without a GC; transferred bytes under 2 %)
  size: { relative: 0.1, absolute: 1024 },
  // up to 4.9 %
  count: { relative: 0.05, absolute: 1 },
  gpuBusy: null,
};

export interface Difference {
  reference: number;
  delta: number;
  /** null when the reference is 0 */
  relative: number | null;
  changed: boolean;
}

export interface Comparison {
  reference: string;
  byId: Map<string, Difference>;
  /** Sorted by how many times the difference exceeds its threshold, largest first */
  changed: Figure[];
  notes: { scenario: ScenarioName; note: string }[];
}

export class VersionMismatch extends Error {
  override readonly name = 'VersionMismatch';
}

function threshold(kind: FigureKind, reference: number): number | null {
  const noise = NOISE[kind];
  return noise === null ? null : Math.max(noise.absolute, noise.relative * Math.abs(reference));
}

const apart = (a: number, b: number) => {
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  return lo <= 0 ? hi > 0 : hi / lo > 2;
};

export function compare(run: Results, reference: Results): Comparison {
  const refVersion: unknown = reference.version;
  if (refVersion !== RESULTS_VERSION)
    throw new VersionMismatch(
      `the reference run ${reference.run.name} is results version ${String(refVersion)}, this tool writes version ${String(RESULTS_VERSION)}: compare runs of the same version`,
    );
  const refFigures = new Map(figures(reference).map((f) => [f.id, f]));
  const byId = new Map<string, Difference>();
  const ranked: { figure: Figure; excess: number }[] = [];
  for (const f of figures(run)) {
    const r = refFigures.get(f.id);
    if (!r) continue;
    const delta = f.value - r.value;
    const limit = threshold(f.kind, r.value);
    const changed = limit !== null && Math.abs(delta) > limit;
    byId.set(f.id, { reference: r.value, delta, relative: r.value === 0 ? null : delta / r.value, changed });
    if (changed) ranked.push({ figure: f, excess: limit > 0 ? Math.abs(delta) / limit : Infinity });
  }
  const notes: Comparison['notes'] = [];
  for (const scenario of SCENARIO_NAMES) {
    if (run.scenarios[scenario] === undefined) continue;
    if (reference.scenarios[scenario] === undefined) {
      notes.push({ scenario, note: `not in the reference run ${reference.run.name}: shown without comparison` });
      continue;
    }
    const refWindows = new Map(windowsOf(reference, scenario).map((w) => [w.id, w]));
    for (const w of windowsOf(run, scenario)) {
      const r = refWindows.get(w.id);
      if (!r) continue;
      if (apart(w.serverUptimeS, r.serverUptimeS) || apart(w.historyPoints, r.historyPoints))
        notes.push({
          scenario,
          note: `window ${w.id}: the server had run ${String(Math.round(w.serverUptimeS))} s with ${String(w.historyPoints)} history points here, ${String(Math.round(r.serverUptimeS))} s with ${String(r.historyPoints)} in the reference`,
        });
    }
  }
  return {
    reference: reference.run.name,
    byId,
    changed: ranked.toSorted((a, b) => b.excess - a.excess).map((x) => x.figure),
    notes,
  };
}
