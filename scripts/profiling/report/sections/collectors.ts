import type { Section } from '../cell.ts';
import { bars, figure, SERIES, table, tiles } from '../charts.ts';
import { code, esc, ms, num } from '../format.ts';
import { section } from './common.ts';

export const collectors: Section = (results, cell) => {
  const s = results.scenarios.collectors;
  if (!s) return null;
  const nvml = s.nvml;
  const nvmlBlock = nvml
    ? `<h3>NVML sampler</h3>
${tiles([
  { label: 'GPUs', value: num(nvml.gpus) },
  { label: 'one sample, CPU', value: cell('collectors.nvml.sampleCpuMs') },
  { label: 'one sample, wall', value: ms(nvml.sampleWallMs) },
])}
${figure(
  bars(
    nvml.calls
      .toSorted((a, b) => b.cpuMs - a.cpuMs)
      .slice(0, 12)
      .map((c) => ({
        label: c.call,
        value: c.cpuMs,
        text: cell.text(`collectors.nvml.${c.call}.cpuMs`),
        tip: `${ms(c.wallMs)} wall`,
      })),
    { title: 'CPU of each NVML call in one sample', labelWidth: 340, color: SERIES[1] },
  ),
  "The calls the app's <code>nvmlReader</code> makes for one sample of every GPU, after the first one, which also reads what the sampler keeps (identity, maxima, driver versions), timed through a proxy on its symbols, in the tool's own process. They are only part of the NVML sampler's CPU: its process also runs Node, encodes and sends each sample, and collects its garbage. Its whole cost is the NVML sampler row of the windows.",
)}`
    : '';
  const reads = s.reads.toSorted((a, b) => b.cpuMs - a.cpuMs);
  return section(
    'collectors',
    'Collectors, call by call',
    "A breakdown, not a verdict: a fix of the sampler or of a read is checked by the CPU of the NVML sampler and of the server's threads in the idle and dashboard scenarios.",
    `${nvmlBlock}
<h3>/proc and sysfs reads of a monitor tick</h3>
<p class="muted">The list of reads is kept in the tool, written from <code>app/server/collectors/</code>: it does not follow the code.</p>
${table(
  ['Read', 'CPU', 'Wall'],
  reads.map((r) => [code(r.label), cell(`collectors.read.${r.label}.cpuMs`), ms(r.wallMs)]),
  [1, 2],
)}
${s.skipped.length > 0 ? `<p>Skipped on this machine: ${s.skipped.map((x) => esc(x)).join('; ')}.</p>` : ''}`,
  );
};
