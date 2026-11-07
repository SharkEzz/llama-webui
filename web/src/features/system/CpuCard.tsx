import { type CpuInfo, SERIES, type SystemSample } from '@llama-webui/shared';
import { Cpu } from 'lucide-react';
import { TimeSeriesChart } from '@/components/charts/TimeSeriesChart';
import { GlassCard } from '@/components/glass/GlassCard';
import { formatPct } from '@/lib/format';
import { CoreHeatmap } from './CoreHeatmap';
import { Facts } from './Facts';

const dec = (v: number, d = 2) =>
  new Intl.NumberFormat('fr-FR', { maximumFractionDigits: d, minimumFractionDigits: d }).format(v);

export function CpuCard({ info, sample }: { info: CpuInfo | null; sample: SystemSample | null }) {
  return (
    <GlassCard title={info?.model || 'Processeur'} icon={Cpu}>
      {!sample ? (
        <p className="text-sm text-muted-foreground">Collecteur système désactivé dans les réglages.</p>
      ) : (
        <div className="flex flex-col gap-4">
          <Facts
            rows={[
              ['Charge totale', formatPct(sample.cpuPct)],
              ['Cœurs / threads', info ? `${info.physicalCores} / ${info.logicalThreads}` : '—'],
              ['Fréquence', sample.freqMhz == null ? '—' : `${dec(sample.freqMhz, 0)} MHz`],
              ['Température', sample.tempC == null ? '—' : `${dec(sample.tempC, 0)} °C`],
              ['Charge moyenne (1, 5, 15 min)', sample.load ? sample.load.map((l) => dec(l)).join(' ; ') : '—'],
            ]}
          />
          <CoreHeatmap cores={sample.corePct} />
          <TimeSeriesChart
            aria-label="Charge CPU de la machine"
            height={120}
            yMax={100}
            format={formatPct}
            series={[{ key: SERIES.sysCpu, label: 'CPU', tone: 'violet' }]}
          />
        </div>
      )}
    </GlassCard>
  );
}
