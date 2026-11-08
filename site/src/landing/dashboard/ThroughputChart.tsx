import { dec } from '@/lib/format';
import { clock, type HistoryPoint } from '../telemetry';

/**
 * Generation and prompt tok/s over the last minute, styled like the app's uPlot chart
 * (web/src/components/charts/chartTheme.ts): 2 px lines, 10 % fill, 0 to max × 1.15, mono axis labels.
 * Plain SVG with a stretched viewBox; strokes keep their width (non-scaling-stroke) and labels are HTML.
 */
const W = 600;
const H = 180;

const SERIES = [
  { key: 'gen', label: 'Generation', color: 'var(--chart-1)' },
  { key: 'pp', label: 'Prompt', color: 'var(--chart-2)' },
] as const;

function niceMax(value: number): { max: number; step: number } {
  const raw = Math.max(20, value * 1.15);
  const step = raw <= 100 ? 25 : raw <= 200 ? 50 : raw <= 500 ? 100 : 250;
  return { max: Math.ceil(raw / step) * step, step };
}

function paths(history: HistoryPoint[], key: 'gen' | 'pp', max: number) {
  const n = Math.max(1, history.length - 1);
  const points = history.map((p, i) => `${((i / n) * W).toFixed(1)},${(H - (p[key] / max) * H).toFixed(1)}`);
  const line = `M${points.join('L')}`;
  return { line, area: `${line}L${W},${H}L0,${H}Z` };
}

export function ThroughputChart({ history }: { history: HistoryPoint[] }) {
  const peak = Math.max(...history.map((p) => Math.max(p.gen, p.pp)));
  const { max, step } = niceMax(peak);
  const ticks = Array.from({ length: max / step + 1 }, (_, i) => i * step);
  const n = Math.max(1, history.length - 1);
  // Every 15 s, away from the edges (a label centered on the first point would run over the y axis).
  const timeTicks = history
    .map((p, i) => ({ at: p.at, x: (i / n) * 100 }))
    .filter((t) => t.at % 15 === 0 && t.x > 6 && t.x < 94);
  const last = history.at(-1);

  return (
    <div className="flex flex-col gap-2">
      <div className="relative ml-9 h-44">
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
          {SERIES.map((s) => {
            const { line, area } = paths(history, s.key, max);
            return (
              <g key={s.key}>
                <path d={area} fill={s.color} fillOpacity={0.1} />
                <path
                  d={line}
                  fill="none"
                  stroke={s.color}
                  strokeWidth={2}
                  strokeLinejoin="round"
                  vectorEffect="non-scaling-stroke"
                />
              </g>
            );
          })}
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
      <div className="mt-6 flex justify-center gap-5 text-xs text-muted-foreground">
        {SERIES.map((s) => (
          <span key={s.key} className="flex items-center gap-1.5">
            <span className="h-0.5 w-3.5 rounded-full" style={{ background: s.color }} />
            {s.label}: <span className="num text-foreground">{last ? dec(last[s.key]) : '—'}</span>
          </span>
        ))}
      </div>
    </div>
  );
}
