import { type CpuInfo, SERIES, type SystemSample } from '@llama-webui/shared';
import { Cpu } from 'lucide-react';
import { TimeSeriesChart } from '@/components/charts/TimeSeriesChart';
import { GlassCard } from '@/components/glass/GlassCard';
import { formatPct, formatTemp, num } from '@/lib/format';
import { CoreHeatmap } from './CoreHeatmap';
import { Facts } from './Facts';

const dec = (v: number, d = 2) => num(d).format(v);

export function CpuCard({ info, sample }: { info: CpuInfo | null; sample: SystemSample | null }) {
  return (
    <GlassCard title={info?.model || 'Processor'} icon={Cpu}>
      {!sample ? (
        <p className="text-sm text-muted-foreground">System collector disabled in Settings.</p>
      ) : (
        <div className="flex flex-col gap-4">
          <Facts
            rows={[
              ['Total load', formatPct(sample.cpuPct)],
              ['Cores / threads', info ? `${info.physicalCores} / ${info.logicalThreads}` : '—'],
              ['Frequency', sample.freqMhz == null ? '—' : `${dec(sample.freqMhz, 0)} MHz`],
              ['Temperature', formatTemp(sample.tempC)],
              ['Load average (1, 5, 15 min)', sample.load ? sample.load.map((l) => dec(l)).join(', ') : '—'],
            ]}
          />
          <CoreHeatmap cores={sample.corePct} />
          <TimeSeriesChart
            aria-label="Machine CPU load"
            height={120}
            yMax={100}
            format={formatPct}
            series={[{ key: SERIES.sysCpu, label: 'CPU', tone: 'blue' }]}
          />
        </div>
      )}
    </GlassCard>
  );
}
