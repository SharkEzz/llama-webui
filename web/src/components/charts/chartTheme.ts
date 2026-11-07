import type { Tone } from '@/components/glass/tones';

/** Série de graphe par ton : --chart-N (validés pour chaque thème), dans l'ordre fixe violet, cyan, ambre, rose. */
const CHART_VAR: Record<Tone, string> = {
  violet: '--chart-1',
  cyan: '--chart-2',
  amber: '--chart-3',
  rose: '--chart-4',
};

export interface ChartTheme {
  axis: string;
  grid: string;
  font: string;
  series: Record<Tone, string>;
}

/** Couleurs lues des variables CSS du thème courant (à relire quand le thème change). */
export function readChartTheme(): ChartTheme {
  const cs = getComputedStyle(document.documentElement);
  const v = (name: string) => cs.getPropertyValue(name).trim();
  return {
    axis: v('--muted-foreground'),
    grid: v('--border'),
    font: `11px "JetBrains Mono Variable", ui-monospace, monospace`,
    series: {
      violet: v(CHART_VAR.violet),
      cyan: v(CHART_VAR.cyan),
      amber: v(CHART_VAR.amber),
      rose: v(CHART_VAR.rose),
    },
  };
}

/** Même couleur à l'opacité `a` (tokens en oklch()). */
export function withAlpha(color: string, a: number): string {
  const m = /^oklch\(([^/)]*)\)$/.exec(color);
  return m ? `oklch(${m[1]!.trim()} / ${a})` : color;
}
