import { SERIES, type SystemSample } from '@llama-webui/shared';
import { MemoryStick } from 'lucide-react';
import { TimeSeriesChart } from '@/components/charts/TimeSeriesChart';
import { GlassCard } from '@/components/glass/GlassCard';
import { Progress } from '@/components/ui/progress';
import { formatBps, formatBytes, formatPct } from '@/lib/format';
import { Facts } from './Facts';

export function MemoryCard({ sample }: { sample: SystemSample | null }) {
  const mem = sample?.mem;
  const bw = sample?.memBw ?? null;
  const used = mem ? mem.totalBytes - mem.availableBytes : 0;
  const pct = mem && mem.totalBytes > 0 ? (100 * used) / mem.totalBytes : 0;
  return (
    <GlassCard title="Mémoire" icon={MemoryStick}>
      {!mem ? (
        <p className="text-sm text-muted-foreground">Collecteur système désactivé dans les réglages.</p>
      ) : (
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <div className="flex items-baseline justify-between text-sm">
              <span>
                <span className="num">{formatBytes(used)}</span>{' '}
                <span className="text-muted-foreground">sur {formatBytes(mem.totalBytes)}</span>
              </span>
              <span className="num text-muted-foreground">{formatPct(pct)}</span>
            </div>
            <Progress value={pct} aria-label="RAM utilisée" />
          </div>
          <Facts
            rows={[
              ['Disponible', formatBytes(mem.availableBytes)],
              ['Cache', formatBytes(mem.cachedBytes)],
              [
                'Swap',
                mem.swapTotalBytes > 0
                  ? `${formatBytes(mem.swapUsedBytes)} / ${formatBytes(mem.swapTotalBytes)}`
                  : 'aucun',
              ],
              [
                'Bande passante DRAM',
                bw ? `↓ ${formatBps(bw.readBps)} · ↑ ${formatBps(bw.writeBps)}` : 'non mesurée (perf)',
              ],
            ]}
          />
          {bw && (
            <TimeSeriesChart
              aria-label="Bande passante DRAM"
              height={120}
              format={formatBps}
              series={[
                { key: SERIES.memRead, label: 'Lecture', tone: 'blue' },
                { key: SERIES.memWrite, label: 'Écriture', tone: 'teal' },
              ]}
            />
          )}
          <TimeSeriesChart
            aria-label="RAM utilisée"
            height={120}
            yMax={100}
            format={formatPct}
            series={[{ key: SERIES.sysMemPct, label: 'RAM', tone: 'teal' }]}
          />
        </div>
      )}
    </GlassCard>
  );
}
