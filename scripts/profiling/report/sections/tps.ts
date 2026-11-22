import type { Section } from '../cell.ts';
import { bars, figure, table } from '../charts.ts';
import { code, num } from '../format.ts';
import { section } from './common.ts';

export const tps: Section = (results, cell) => {
  const s = results.scenarios.tps;
  if (!s) return null;
  const rows = s.modes.map((m) => ({
    label: m.id,
    value: cell.value(`tps.${m.id}.tokensPerSec`) ?? 0,
    text: cell.text(`tps.${m.id}.tokensPerSec`),
  }));
  return section(
    'tps',
    'llama-server throughput',
    "llama-server's own tokens per second for a fixed request and seed, with no page, with the Dashboard open and with a static page open; mean of the runs.",
    `${figure(bars(rows, { title: 'Tokens per second by page open', labelWidth: 200 }), 'Mean tokens per second of the runs.')}
${table(
  ['Page open', 'Mean', 'Runs'],
  s.modes.map((m) => [code(m.id), cell(`tps.${m.id}.tokensPerSec`), m.tokensPerSec.map((t) => num(t, 1)).join(', ')]),
  [1],
)}`,
  );
};
