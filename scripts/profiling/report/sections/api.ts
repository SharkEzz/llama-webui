import type { Section } from '../cell.ts';
import { bars, figure, SERIES, table } from '../charts.ts';
import { code } from '../format.ts';
import { section } from './common.ts';

export const api: Section = (results, cell) => {
  const s = results.scenarios.api;
  if (!s) return null;
  const rows = s.routes.map((r) => [
    code(r.url),
    cell(`api.${r.url}.firstMs`),
    cell(`api.${r.url}.p50Ms`),
    cell(`api.${r.url}.p95Ms`),
    cell(`api.${r.url}.bytes`),
  ]);
  const slowest = s.routes
    .toSorted((a, b) => b.p50Ms - a.p50Ms)
    .slice(0, 10)
    .map((r) => ({ label: r.url, value: r.p50Ms, text: cell.text(`api.${r.url}.p50Ms`) }));
  return section(
    'api',
    'API latency',
    'Every GET the pages make, replayed 20 times one after the other; first call, median and 95th percentile.',
    `${figure(bars(slowest, { title: 'Slowest routes, median', labelWidth: 340, color: SERIES[3] }), 'Slowest routes by median duration.')}
${table(['Route', 'First', 'p50', 'p95', 'Size'], rows, [1, 2, 3, 4])}`,
  );
};
