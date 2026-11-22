import { LOAD_FIELDS } from '../../figures.ts';
import type { Section } from '../cell.ts';
import { details, table } from '../charts.ts';
import { bytes, esc, num } from '../format.ts';
import { section } from './common.ts';

export const load: Section = (results, cell) => {
  const s = results.scenarios.load;
  if (!s) return null;
  const caches = (['cold', 'warm'] as const).filter((c) => s.loads.some((l) => l.cache === c));
  const rows = LOAD_FIELDS.map(({ field, label }) =>
    [esc(label)].concat(caches.map((c) => cell(`load.${c}.${field}`))),
  );
  const first = s.loads.find((l) => l.cache === 'cold') ?? s.loads[0];
  const kinds = first
    ? Object.entries(first.byKind)
        .filter(([, k]) => k.count > 0)
        .toSorted((a, b) => b[1].bytes - a[1].bytes)
        .map(([kind, k]) => [esc(kind), num(k.count), bytes(k.bytes)])
    : [];
  return section(
    'load',
    'Dashboard load',
    'The Dashboard opened in a new browser context, cold then warm cache, three loads each; medians.',
    `${table(
      ['Median', ...caches.map((c) => `${c} cache`)],
      rows,
      caches.map((_, i) => i + 1),
    )}
${details('Resources of a cold load, by kind', table(['Kind', 'Requests', 'Bytes on the wire'], kinds, [1, 2]))}`,
  );
};
