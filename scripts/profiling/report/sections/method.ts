import { NOISE } from '../../compare.ts';
import type { FigureKind } from '../../figures.ts';
import type { Section } from '../cell.ts';
import { table } from '../charts.ts';
import { bytes, esc, ms, num, pct } from '../format.ts';
import { section } from './common.ts';

const KIND_LABEL: Record<FigureKind, string> = {
  cpu: 'CPU of a process or thread (points of one core)',
  share: 'share of a thread’s time (points)',
  tps: 'tokens per second',
  duration: 'duration',
  size: 'size',
  count: 'count',
  gpuBusy: 'AMD gpu_busy_percent',
};

const KINDS: FigureKind[] = ['cpu', 'share', 'tps', 'duration', 'size', 'count', 'gpuBusy'];

function floor(kind: FigureKind, absolute: number): string {
  if (kind === 'cpu' || kind === 'share') return `${num(absolute, 1)} pt`;
  if (kind === 'duration') return ms(absolute);
  if (kind === 'size') return bytes(absolute);
  return num(absolute, absolute % 1 === 0 ? 0 : 2);
}

export const method: Section = () => {
  const noise = KINDS.map((kind) => {
    const n = NOISE[kind];
    return [
      esc(KIND_LABEL[kind]),
      n === null
        ? '<span class="muted">indicative, never a change</span>'
        : n.relative > 0
          ? pct(n.relative * 100, 0)
          : '—',
      n === null ? '—' : n.absolute > 0 ? floor(kind, n.absolute) : '—',
    ];
  });
  return section(
    'method',
    'Method',
    'How each kind of figure is taken.',
    `<ul>
<li><strong>CPU and memory</strong>: <code>/proc/&lt;pid&gt;/stat</code> and <code>/proc/&lt;pid&gt;/task/*/stat</code> of every process of the server and of Chromium, read every second; a window’s CPU is the ticks spent between its first and last reading, in % of one core, user and system apart; RSS is that of the last reading. Threads of a pool are merged by name.</li>
<li><strong>AMD GPUs</strong>: <code>gpu_busy_percent</code> of each amdgpu card, mean of the readings; an indicative gauge, never counted as a change.</li>
<li><strong>Page</strong>: deltas of CDP <code>Performance.getMetrics</code> over the window (task, script, layout and style durations as a share of the window), React commits counted by a DevTools hook, long tasks by a <code>PerformanceObserver</code>, the JS heap, DOM nodes and listeners at the end.</li>
<li><strong>/ws</strong>: frames received by the page, by message type.</li>
<li><strong>Profiles</strong>: the server’s through its inspector, the page’s through CDP, symbolicated with the build’s source maps; time is charged to the function on top of the stack. A window under a profiler or a trace is tagged so: its CPU and the server’s event loop are inflated by the profiler and its figures compare only with another profiled window.</li>
<li><strong>Traces</strong>: Chromium’s trace of the window: frames drawn per second, self time on the renderer’s main thread by category.</li>
<li><strong>Loads</strong>: Navigation and Paint Timing of a new browser context; a cold load starts with an empty cache.</li>
<li><strong>Throughput</strong>: llama-server’s own <code>timings.predicted_per_second</code> for a fixed request and seed.</li>
</ul>
<h3>Noise thresholds</h3>
<p>A difference is a change when it exceeds both the share of the reference and the floor of its kind, twice that in a profiled window; under it, the figure is shown as unchanged. The thresholds come from two runs on unchanged code: a smaller difference, a small process’s CPU for one, may still be real; read the raw difference or repeat the runs.</p>
${table(['Kind of figure', 'Share of the reference', 'Floor'], noise, [1, 2])}`,
  );
};
