import { SERIES } from '@llama-webui/shared';
import { TextCursorInput, Zap } from 'lucide-react';
import { useState } from 'react';
import { TimeSeriesChart } from '@/components/charts/TimeSeriesChart';
import { GlassCard } from '@/components/glass/GlassCard';
import { fmt } from '@/lib/format';

const tps = (v: number) => fmt(v, v < 10 ? 1 : 0);

const METRICS = {
  generation: {
    title: 'Generation (tok/s)',
    icon: Zap,
    series: { key: SERIES.genTps, label: 'Generation', tone: 'blue' },
    ariaLabel: 'Generation throughput in tokens per second',
  },
  prompt: {
    title: 'Prompt (tok/s)',
    icon: TextCursorInput,
    series: { key: SERIES.ppTps, label: 'Prompt', tone: 'teal' },
    ariaLabel: 'Prompt throughput in tokens per second',
  },
} as const;

/** Cursor shared by the two throughput charts: both legends read the same instant. */
const SYNC_KEY = 'dashboard-throughput';

/**
 * Generation or prompt throughput (tok/s) over the history. One chart per metric: prompt processing runs an order
 * of magnitude faster than generation, so each needs its own scale. The chart takes the height the card is given,
 * and its legend sits in the card header to leave that height to the plot.
 */
export function ThroughputCard({ metric }: { metric: keyof typeof METRICS }) {
  const { title, icon, series, ariaLabel } = METRICS[metric];
  const [legend, setLegend] = useState<HTMLDivElement | null>(null);
  return (
    <GlassCard
      title={title}
      icon={icon}
      actions={<div ref={setLegend} className="ts-legend" />}
      contentClassName="flex min-h-0 flex-1 flex-col"
    >
      {legend && (
        <TimeSeriesChart
          aria-label={ariaLabel}
          fill
          syncKey={SYNC_KEY}
          legendTarget={legend}
          series={[series]}
          format={tps}
        />
      )}
    </GlassCard>
  );
}
