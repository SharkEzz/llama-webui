import type { Section } from '../cell.ts';
import { bars, figure, SERIES, table, tiles } from '../charts.ts';
import { code, esc, ms, num } from '../format.ts';
import { section } from './common.ts';

/** How often a call runs at 1 Hz, from how many of 60 samples make it. */
const cadence = (runsPerMinute: number): string => {
  if (runsPerMinute >= 60) return 'every sample';
  if (runsPerMinute <= 1) return 'once';
  return `every ${num(60 / runsPerMinute)} s`;
};

export const collectors: Section = (results, cell) => {
  const s = results.scenarios.collectors;
  if (!s) return null;
  const nvml = s.nvml;
  const nvmlBlock = nvml
    ? `<h3>NVML sampler</h3>
${tiles([
  { label: 'GPUs', value: num(nvml.gpus) },
  { label: 'full sample, CPU', value: cell('collectors.nvml.sampleCpuMs') },
  { label: 'full sample, wall', value: ms(nvml.sampleWallMs) },
  ...(nvml.lightCpuMs === undefined
    ? []
    : [
        { label: 'light sample, CPU', value: cell('collectors.nvml.lightCpuMs') },
        { label: 'light sample, wall', value: ms(nvml.lightWallMs ?? 0) },
        { label: 'on average at 1 Hz, CPU', value: cell('collectors.nvml.avgCpuMs') },
      ]),
])}
${figure(
  bars(
    nvml.calls
      .toSorted((a, b) => b.cpuMs - a.cpuMs)
      .slice(0, 12)
      .map((c) => ({
        label: c.runsPerMinute === undefined ? c.call : `${c.call}, ${cadence(c.runsPerMinute)}`,
        value: c.cpuMs,
        text: cell.text(`collectors.nvml.${c.call}.cpuMs`),
        tip: `${ms(c.wallMs)} wall`,
      })),
    { title: 'CPU of each NVML call in a full sample', labelWidth: 420, color: SERIES[1] },
  ),
  "The calls the app's <code>nvmlReader</code> makes for a full sample of every GPU, one where every value it reads again only once its period passed is due (the PCIe throughput, the power limit, the persistence mode), timed through a proxy on its symbols, in the tool's own process. The first sample, which also reads what the sampler keeps (identity, maxima, driver versions), is dropped. A light sample is one where no period passed; the average at 1 Hz adds to it the calls it leaves out, as often as they run in a minute of samples at 1 Hz, the default interval (counted on a reader of its own, the label's cadence). They are only part of the NVML sampler's CPU: its process also runs Node, encodes and sends each sample, and collects its garbage. Its whole cost is the NVML sampler row of the windows.",
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
