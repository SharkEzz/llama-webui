import { type DiskSample, SERIES } from '@llama-webui/shared';
import { HardDrive } from 'lucide-react';
import { TimeSeriesChart } from '@/components/charts/TimeSeriesChart';
import { GlassCard } from '@/components/glass/GlassCard';
import { formatBps } from '@/lib/format';
import { Facts } from './Facts';

export function DiskCard({ sample }: { sample: DiskSample | null }) {
  return (
    <GlassCard title="Disques" icon={HardDrive}>
      {!sample ? (
        <p className="text-sm text-muted-foreground">Collecteur disque désactivé dans les réglages.</p>
      ) : (
        <div className="flex flex-col gap-4">
          <Facts
            rows={[
              ['Lecture (machine)', formatBps(sample.readBps)],
              ['Écriture (machine)', formatBps(sample.writeBps)],
              [
                sample.model ? `Lecture du disque du modèle (${sample.model.disk})` : 'Disque du modèle',
                sample.model ? formatBps(sample.model.readBps) : '—',
              ],
            ]}
          />
          <TimeSeriesChart
            aria-label="Débit des disques"
            height={120}
            format={(v) => formatBps(v)}
            series={[
              { key: SERIES.diskRead, label: 'Lecture', tone: 'blue' },
              { key: SERIES.diskWrite, label: 'Écriture', tone: 'teal' },
              { key: SERIES.modelDiskRead, label: 'Disque du modèle', tone: 'amber' },
            ]}
          />
        </div>
      )}
    </GlassCard>
  );
}
