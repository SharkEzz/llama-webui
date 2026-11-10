import { useEffect, useEffectEvent, useMemo, useRef } from 'react';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import type { Tone } from '@/components/glass/tones';
import { formatTime, num } from '@/lib/format';
import { useMonitor } from '@/lib/monitor';
import { useTheme } from '@/lib/theme';
import { cn } from '@/lib/utils';
import { readChartTheme, withAlpha } from './chartTheme';

export interface ChartSeries {
  key: string;
  label: string;
  tone: Tone;
}

interface TimeSeriesChartProps {
  series: ChartSeries[];
  /** Height of the plot, legend excluded. Ignored with `fill`. */
  height?: number;
  /** Follow the height of the parent (a flex column) instead of `height`; the legend is taken out of it. */
  fill?: boolean;
  /** Element (with the `ts-legend` class) that receives the legend instead of the space under the plot. */
  legendTarget?: HTMLElement | null;
  /** Fixed upper bound (100 for a percentage); otherwise follows the data. */
  yMax?: number;
  /** Y axis and legend values. */
  format?(v: number): string;
  /** Compact version (sparkline): no axes, no legend. */
  compact?: boolean;
  /** Charts with the same key share their cursor: hovering one moves the cursor and the legend of the others. */
  syncKey?: string;
  className?: string;
  'aria-label'?: string;
}

const defaultFormat = (v: number) => num(1, 0).format(v);

/**
 * Time series from the monitoring history (uPlot). The chart is created once per series set and theme, then only
 * fed (setData) on each tick; null = gap. Live legend = values under the cursor.
 */
export function TimeSeriesChart({
  series,
  height = 160,
  fill = false,
  yMax,
  format = defaultFormat,
  compact = false,
  syncKey,
  legendTarget,
  className,
  ...aria
}: TimeSeriesChartProps) {
  const host = useRef<HTMLDivElement>(null);
  const plot = useRef<uPlot | null>(null);
  const resolved = useTheme((s) => s.resolved);
  const version = useMonitor((s) => s.version);
  const signature = series.map((s) => `${s.key}:${s.tone}:${s.label}`).join('|');
  const fmt = useRef(format);
  fmt.current = format;

  // biome-ignore lint/correctness/useExhaustiveDependencies: version triggers the history reread (read outside the closure); signature sums up `series`
  const data = useMemo((): uPlot.AlignedData => {
    const { times, series: all } = useMonitor.getState().history;
    return [times, ...series.map((s) => all.get(s.key) ?? new Array<number | null>(times.length).fill(null))];
  }, [version, signature]);

  // Current series and data, read at creation without rerunning it: data is pushed by the next effect
  // (no re-creation on every tick), series are summed up by `signature`.
  const latest = useEffectEvent(() => ({ series, data }));

  // Creation: per series set, theme (colors read from CSS variables) and shape.
  // biome-ignore lint/correctness/useExhaustiveDependencies: signature and resolved are triggers (series read via latest, colors via readChartTheme)
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const { series, data } = latest();
    const theme = readChartTheme();
    const axis: uPlot.Axis = {
      stroke: theme.axis,
      font: theme.font,
      grid: { stroke: theme.grid, width: 1 },
      ticks: { show: false },
    };
    const opts: uPlot.Options = {
      width: Math.max(1, el.clientWidth),
      height,
      padding: compact ? [2, 0, 2, 0] : [8, 20, 0, 0],
      legend: {
        show: !compact,
        live: true,
        ...(legendTarget ? { mount: (_u: uPlot, legend: HTMLElement) => legendTarget.append(legend) } : {}),
      },
      cursor: compact
        ? { show: false }
        : {
            points: { size: 8, width: 2, stroke: () => 'transparent' },
            drag: { x: false, y: false },
            ...(syncKey ? { sync: { key: syncKey } } : {}),
          },
      scales: {
        x: { time: true },
        y: { range: (_u, _min, max) => [0, yMax ?? Math.max(1, max * 1.15)] },
      },
      axes: compact
        ? [{ show: false }, { show: false }]
        : [
            {
              ...axis,
              values: (_u, splits) => splits.map((s) => formatTime(s * 1000)),
              space: 80,
              // uPlot keeps 50 px under the plot for the time labels; a chart that fills a tight card gets them back.
              ...(fill ? { size: 26 } : {}),
            },
            { ...axis, values: (_u, splits) => splits.map((v) => fmt.current(v)), size: 64, space: 32 },
          ],
      series: [
        { label: 'Time', value: (_u, v) => (v == null ? '—' : formatTime(v * 1000)) },
        ...series.map(
          (s): uPlot.Series => ({
            label: s.label,
            stroke: theme.series[s.tone],
            fill: withAlpha(theme.series[s.tone], 0.1),
            width: compact ? 1.5 : 2,
            points: { show: false },
            value: (_u, v) => (v == null ? '—' : fmt.current(v)),
          }),
        ),
      ],
    };
    const u = new uPlot(opts, data, el);
    plot.current = u;
    const size = () => {
      const width = Math.max(1, el.clientWidth);
      if (!fill) return { width, height };
      // What the root measures beyond the plot (legend and its margin) comes out of the host's height. The root is
      // out of the flow (.ts-chart-fill), so the plot never feeds back into the height it is sized from.
      const chrome = u.root.offsetHeight - u.height;
      return { width, height: Math.max(1, el.clientHeight - chrome) };
    };
    const ro = new ResizeObserver(() => u.setSize(size()));
    ro.observe(el);
    return () => {
      ro.disconnect();
      u.destroy();
      plot.current = null;
    };
  }, [signature, resolved, height, fill, yMax, compact, syncKey, legendTarget]);

  useEffect(() => {
    plot.current?.setData(data);
  }, [data]);

  return (
    <div
      ref={host}
      role="img"
      // contain-inline-size: the plot is sized from the host's width, so it must not count in that width (inside a
      // flex row or a fit-content ancestor, a plot rounded up by a fraction of a pixel would widen its own host).
      className={cn(
        'ts-chart w-full min-w-0 contain-inline-size',
        fill && 'ts-chart-fill relative min-h-28 flex-1',
        className,
      )}
      {...aria}
    />
  );
}
