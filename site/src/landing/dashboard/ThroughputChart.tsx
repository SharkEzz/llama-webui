import { dec } from '@/lib/format';
import { clock, type HistoryPoint } from '../telemetry';

/**
 * Generation or prompt tok/s over the last minute, styled like the app's uPlot chart
 * (web/src/components/charts/chartTheme.ts): 2 px line, 10 % fill, 0 to max × 1.15, mono axis labels. One chart per
 * series, as on the app's Dashboard: prompt runs an order of magnitude faster, so each has its own scale.
 * Plain SVG with a stretched viewBox; strokes keep their width (non-scaling-stroke) and labels are HTML.
 */
const W = 600;
const H = 100;

export const THROUGHPUT = {
  gen: { title: 'Generation (tok/s)', label: 'Generation', color: 'var(--chart-1)' },
  pp: { title: 'Prompt (tok/s)', label: 'Prompt', color: 'var(--chart-2)' },
} as const;

export type ThroughputSeries = keyof typeof THROUGHPUT;

const STEPS = [10, 25, 50, 100, 250, 500, 1000];

/** Upper bound and grid step: at most three intervals, the chart is short. */
function niceMax(value: number): { max: number; step: number } {
  const raw = Math.max(20, value * 1.15);
  const step = STEPS.find((s) => raw / s <= 3) ?? 1000;
  return { max: Math.ceil(raw / step) * step, step };
}

function paths(history: HistoryPoint[], key: ThroughputSeries, max: number) {
  const n = Math.max(1, history.length - 1);
  const points = history.map((p, i) => `${((i / n) * W).toFixed(1)},${(H - (p[key] / max) * H).toFixed(1)}`);
  const line = `M${points.join('L')}`;
  return { line, area: `${line}L${W},${H}L0,${H}Z` };
}

export function ThroughputChart({ history, series }: { history: HistoryPoint[]; series: ThroughputSeries }) {
  const { color } = THROUGHPUT[series];
  const { max, step } = niceMax(Math.max(...history.map((p) => p[series])));
  const ticks = Array.from({ length: max / step + 1 }, (_, i) => i * step);
  const n = Math.max(1, history.length - 1);
  // Every 15 s, away from the edges (a label centered on the first point would run over the y axis).
  const timeTicks = history
    .map((p, i) => ({ at: p.at, x: (i / n) * 100 }))
    .filter((t) => t.at % 15 === 0 && t.x > 6 && t.x < 94);
  const { line, area } = paths(history, series, max);

  return (
    // Takes the height its panel is given (the System card beside it may be taller); the bottom margin holds the
    // time labels, which hang under the plot.
    <div className="relative mb-5 ml-9 min-h-24 flex-1">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        className="absolute inset-0 size-full overflow-visible"
        aria-hidden="true"
      >
        {ticks.map((t) => (
          <line
            key={t}
            x1={0}
            x2={W}
            y1={H - (t / max) * H}
            y2={H - (t / max) * H}
            stroke="var(--border)"
            vectorEffect="non-scaling-stroke"
          />
        ))}
        {timeTicks.map((t) => (
          <line
            key={t.at}
            x1={(t.x / 100) * W}
            x2={(t.x / 100) * W}
            y1={0}
            y2={H}
            stroke="var(--border)"
            vectorEffect="non-scaling-stroke"
          />
        ))}
        <path d={area} fill={color} fillOpacity={0.1} />
        <path
          d={line}
          fill="none"
          stroke={color}
          strokeWidth={2}
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      {ticks.map((t) => (
        <span
          key={t}
          className="num absolute -left-9 w-7 -translate-y-1/2 text-right text-[11px] text-muted-foreground"
          style={{ top: `${100 - (t / max) * 100}%` }}
        >
          {t}
        </span>
      ))}
      {timeTicks.map((t) => (
        <span
          key={t.at}
          className="num absolute top-full mt-1.5 -translate-x-1/2 text-[11px] text-muted-foreground"
          style={{ left: `${t.x}%` }}
        >
          {clock(t.at)}
        </span>
      ))}
    </div>
  );
}

/** The chart's legend, in the card header as in the app: the series marker and its latest value. */
export function ThroughputLegend({ history, series }: { history: HistoryPoint[]; series: ThroughputSeries }) {
  const { label, color } = THROUGHPUT[series];
  const last = history.at(-1);
  return (
    <span className="flex items-center gap-1.5 text-xs font-normal tracking-normal text-muted-foreground">
      <span className="h-0.5 w-3.5 rounded-full" style={{ background: color }} />
      {label}: <span className="num text-foreground">{last ? dec(last[series]) : '—'}</span>
    </span>
  );
}
