// The one way a comparable number reaches the report: `cell(id)` prints the figure's value and, against a reference,
// the reference and the signed difference (or "unchanged" under the noise threshold).
import type { Comparison } from '../compare.ts';
import { type Figure, figures } from '../figures.ts';
import type { Results } from '../results.ts';
import { delta, esc, value } from './format.ts';

export interface Cell {
  /** HTML: the value, then the reference and the difference when comparing; a dash for an unknown id */
  (id: string): string;
  /** the raw value, for a chart */
  value: (id: string) => number | null;
  /** the formatted value alone, for a chart label */
  text: (id: string) => string;
  figure: (id: string) => Figure | undefined;
  comparing: boolean;
}

export function makeCell(results: Results, comparison: Comparison | null): Cell {
  const byId = new Map(figures(results).map((f) => [f.id, f]));
  const cell = (id: string): string => {
    const f = byId.get(id);
    if (!f) return '<span class="muted">—</span>';
    const v = `<span class="v">${esc(value(f.value, f.kind))}</span>`;
    const d = comparison?.byId.get(id);
    if (!d) return v;
    const ref = `<span class="ref">ref ${esc(value(d.reference, f.kind))}</span>`;
    if (f.kind === 'gpuBusy') return `${v}${ref}<span class="d same">${esc(delta(d.delta, f.kind))}, indicative</span>`;
    if (!d.changed) return `${v}${ref}<span class="d same">unchanged</span>`;
    return `${v}${ref}<span class="d changed">${esc(delta(d.delta, f.kind))}</span>`;
  };
  cell.value = (id: string) => byId.get(id)?.value ?? null;
  cell.text = (id: string) => {
    const f = byId.get(id);
    return f ? value(f.value, f.kind) : '—';
  };
  cell.figure = (id: string) => byId.get(id);
  cell.comparing = comparison !== null;
  return cell;
}

/** A section renderer: null when its scenario is absent from the run. */
export type Section = (results: Results, cell: Cell) => string | null;
