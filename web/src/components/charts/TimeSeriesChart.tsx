import { useEffect, useMemo, useRef } from 'react';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import type { Tone } from '@/components/glass/tones';
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
  height?: number;
  /** Borne haute fixe (100 pour un pourcentage) ; sinon suit les données. */
  yMax?: number;
  /** Valeurs de l'axe Y et de la légende. */
  format?(v: number): string;
  /** Version compacte (sparkline) : ni axes ni légende. */
  compact?: boolean;
  className?: string;
  'aria-label'?: string;
}

const timeFmt = new Intl.DateTimeFormat('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const defaultFormat = (v: number) => new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 1 }).format(v);

/**
 * Série temporelle de l'historique de monitoring (uPlot). Le graphe est créé une fois par jeu de séries et par thème,
 * puis seulement alimenté (setData) à chaque tick ; null = trou. Légende vivante = valeurs sous le curseur.
 */
export function TimeSeriesChart({
  series,
  height = 160,
  yMax,
  format = defaultFormat,
  compact = false,
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

  // biome-ignore lint/correctness/useExhaustiveDependencies: version déclenche la relecture de l'historique (lu hors closure) ; signature résume `series`
  const data = useMemo((): uPlot.AlignedData => {
    const { times, series: all } = useMonitor.getState().history;
    return [times, ...series.map((s) => all.get(s.key) ?? new Array<number | null>(times.length).fill(null))];
  }, [version, signature]);

  // Création : par jeu de séries, thème (couleurs lues des variables CSS) et forme.
  // biome-ignore lint/correctness/useExhaustiveDependencies: création par signature/thème/forme ; data est poussée par l'effet suivant (pas de recréation à chaque tick)
  useEffect(() => {
    const el = host.current;
    if (!el) return;
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
      legend: { show: !compact, live: true },
      cursor: compact
        ? { show: false }
        : { points: { size: 8, width: 2, stroke: () => 'transparent' }, drag: { x: false, y: false } },
      scales: {
        x: { time: true },
        y: { range: (_u, _min, max) => [0, yMax ?? Math.max(1, max * 1.15)] },
      },
      axes: compact
        ? [{ show: false }, { show: false }]
        : [
            { ...axis, values: (_u, splits) => splits.map((s) => timeFmt.format(s * 1000)), space: 80 },
            { ...axis, values: (_u, splits) => splits.map((v) => fmt.current(v)), size: 64, space: 32 },
          ],
      series: [
        { label: 'Heure', value: (_u, v) => (v == null ? '—' : timeFmt.format(v * 1000)) },
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
    const ro = new ResizeObserver(() => u.setSize({ width: Math.max(1, el.clientWidth), height }));
    ro.observe(el);
    return () => {
      ro.disconnect();
      u.destroy();
      plot.current = null;
    };
    // data : poussées par l'effet suivant, pas de recréation à chaque tick.
  }, [signature, resolved, height, yMax, compact]);

  useEffect(() => {
    plot.current?.setData(data);
  }, [data]);

  return <div ref={host} role="img" className={cn('ts-chart w-full min-w-0', className)} {...aria} />;
}
