import type { Section } from '../cell.ts';
import { bars, details, figure, SERIES, table } from '../charts.ts';
import { code, esc } from '../format.ts';
import { groupLabel, MAIN_GROUPS, section, windowsBlock } from './common.ts';

export const aurora: Section = (results, cell) => {
  const s = results.scenarios.aurora;
  if (!s) return null;
  const variants = s.variants.map((v) => v.window);
  const chart = (group: string, title: string, color: string | undefined) => {
    const rows = variants.map((w) => {
      const id = `aurora.${w.id}.cpu.${group}`;
      return { label: w.label, value: cell.value(id) ?? 0, text: cell.text(id) };
    });
    return figure(bars(rows, { title, labelWidth: 300, ...(color === undefined ? {} : { color }) }), title);
  };
  const cards = [...new Set(variants.flatMap((w) => Object.keys(w.procs.gpuBusyPct)))];
  const head = ['Variant', ...MAIN_GROUPS.map(groupLabel), ...cards.map((c) => `gpu_busy ${esc(c)}`)];
  const rows = variants.map((w) => [
    esc(w.label),
    ...MAIN_GROUPS.map((g) => cell(`aurora.${w.id}.cpu.${g}`)),
    ...cards.map((c) => cell(`aurora.${w.id}.gpu.${c}`)),
  ]);
  return section(
    'aurora',
    'Compositor and GPU',
    'The Dashboard under CSS variants injected into the page, one window each, in this order.',
    `${chart('chrome-gpu', 'CPU of the Chromium GPU process by variant', undefined)}
${chart('chrome-renderer', 'CPU of the page renderer by variant', SERIES[1])}
${table(head, rows, head.map((_, i) => i).slice(1))}
${details(
  'CSS of each variant',
  table(
    ['Variant', 'CSS injected'],
    s.variants.map((v) => [esc(v.window.label), v.css === '' ? '<span class="muted">none</span>' : code(v.css)]),
  ),
)}
${details('Every window', windowsBlock('aurora', variants, cell))}`,
  );
};
