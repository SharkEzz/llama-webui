import type { Tone } from '@/components/glass/tones';

/** Chart series per tone: --chart-N (validated for each theme), in the fixed order blue, teal, amber, rose. */
const CHART_VAR: Record<Tone, string> = {
  blue: '--chart-1',
  teal: '--chart-2',
  amber: '--chart-3',
  rose: '--chart-4',
};

export interface ChartTheme {
  axis: string;
  grid: string;
  font: string;
  series: Record<Tone, string>;
}

/** Colors read from the current theme's CSS variables (reread when the theme changes). */
export function readChartTheme(): ChartTheme {
  const cs = getComputedStyle(document.documentElement);
  const v = (name: string) => cs.getPropertyValue(name).trim();
  return {
    axis: v('--muted-foreground'),
    grid: v('--border'),
    font: `11px "JetBrains Mono Variable", ui-monospace, monospace`,
    series: {
      blue: v(CHART_VAR.blue),
      teal: v(CHART_VAR.teal),
      amber: v(CHART_VAR.amber),
      rose: v(CHART_VAR.rose),
    },
  };
}

/** Same color at opacity `a` (tokens in oklch()). */
export function withAlpha(color: string, a: number): string {
  const m = /^oklch\(([^/)]*)\)$/.exec(color);
  return m ? `oklch(${m[1]!.trim()} / ${a})` : color;
}
