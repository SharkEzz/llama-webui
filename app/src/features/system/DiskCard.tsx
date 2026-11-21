import { type DiskSample, SERIES } from '@llama-webui/shared';
import { HardDrive } from 'lucide-react';
import { TimeSeriesChart } from '@/components/charts/TimeSeriesChart';
import { GlassCard } from '@/components/glass/GlassCard';
import { formatBps } from '@/lib/format';
import { Facts } from './Facts';

export function DiskCard({ sample }: { sample: DiskSample | null }) {
  return (
    <GlassCard title="Disks" icon={HardDrive}>
      {!sample ? (
        <p className="text-sm text-muted-foreground">Disk collector disabled in Settings.</p>
      ) : (
        <div className="flex flex-col gap-4">
          <Facts
            rows={[
              ['Read (machine)', formatBps(sample.readBps)],
              ['Write (machine)', formatBps(sample.writeBps)],
              [
                sample.model ? `Model disk read (${sample.model.disk})` : 'Model disk',
                sample.model ? formatBps(sample.model.readBps) : '—',
              ],
            ]}
          />
          <TimeSeriesChart
            aria-label="Disk throughput"
            height={120}
            format={(v) => formatBps(v)}
            series={[
              { key: SERIES.diskRead, label: 'Read', tone: 'blue' },
              { key: SERIES.diskWrite, label: 'Write', tone: 'teal' },
              { key: SERIES.modelDiskRead, label: 'Model disk', tone: 'amber' },
            ]}
          />
        </div>
      )}
    </GlassCard>
  );
}
