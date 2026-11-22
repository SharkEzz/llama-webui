import type { Section } from '../cell.ts';
import { line, SERIES, tiles } from '../charts.ts';
import { num } from '../format.ts';
import { section, windowsBlock } from './common.ts';

export const soak: Section = (results, cell) => {
  const s = results.scenarios.soak;
  if (!s) return null;
  const x = (t: number) => `${num(t)} s`;
  const chart = (title: string, ys: number[], unit: string, digits: number, color?: string) =>
    `<figure>${line(
      s.readings.map((r, i) => ({ x: r.t, y: ys[i] ?? 0 })),
      { title, xLabel: x, yLabel: (y) => `${num(y, digits)}${unit}`, ...(color === undefined ? {} : { color }) },
    )}<figcaption>${title}</figcaption></figure>`;
  return section(
    'soak',
    'Dashboard over five minutes',
    'The Dashboard left open, a reading every 10 s (JS heap after a forced GC, DOM nodes, listeners, server RSS); the server heap and RSS after a forced GC through its inspector at the start and at the end.',
    `${tiles([
      { label: 'page JS heap after GC, end', value: cell('soak.heapMb.end') },
      { label: 'DOM nodes, end', value: cell('soak.nodes.end') },
      { label: 'event listeners, end', value: cell('soak.listeners.end') },
      { label: 'server RSS after GC, end', value: cell('soak.server.rssAfterGc') },
      { label: 'server heap after GC, end', value: cell('soak.server.heapAfterGc') },
      { label: 'server RSS growth', value: cell('soak.server.rssGrowth') },
    ])}
<div class="two">
${chart(
  'Page JS heap after GC',
  s.readings.map((r) => r.heapMb),
  ' MiB',
  1,
)}
${chart(
  'Server RSS',
  s.readings.map((r) => r.serverRssMb),
  ' MiB',
  0,
  SERIES[1],
)}
${chart(
  'DOM nodes',
  s.readings.map((r) => r.nodes),
  '',
  0,
  SERIES[2],
)}
${chart(
  'Event listeners',
  s.readings.map((r) => r.listeners),
  '',
  0,
  SERIES[3],
)}
</div>
${windowsBlock('soak', s.windows, cell)}`,
  );
};
