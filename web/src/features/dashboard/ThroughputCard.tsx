import { SERIES } from '@llama-webui/shared';
import { Zap } from 'lucide-react';
import { TimeSeriesChart } from '@/components/charts/TimeSeriesChart';
import { GlassCard } from '@/components/glass/GlassCard';
import { fmt } from '@/lib/format';

const tps = (v: number) => fmt(v, v < 10 ? 1 : 0);

/** Generation and prompt throughput (tok/s) over the history. */
export function ThroughputCard() {
  return (
    <GlassCard title="Throughput (tok/s)" icon={Zap}>
      <TimeSeriesChart
        aria-label="Generation and prompt throughput in tokens per second"
        height={200}
        series={[
          { key: SERIES.genTps, label: 'Generation', tone: 'blue' },
          { key: SERIES.ppTps, label: 'Prompt', tone: 'teal' },
        ]}
        format={tps}
      />
    </GlassCard>
  );
}
