import { type GpuSample, SERIES } from '@llama-webui/shared';
import { MonitorCog } from 'lucide-react';
import { TimeSeriesChart } from '@/components/charts/TimeSeriesChart';
import { Gauge } from '@/components/glass/Gauge';
import { GlassCard } from '@/components/glass/GlassCard';
import { Badge } from '@/components/ui/badge';
import { fmt, formatBps, formatBytes, formatPct, formatTemp } from '@/lib/format';
import { Facts } from './Facts';

const n = (v: number | null | undefined, unit: string, digits = 0) =>
  v == null || !Number.isFinite(v) ? '—' : `${fmt(v, digits)} ${unit}`;

function pcie(g: GpuSample): string {
  if (g.pcieGen == null) return '—';
  const cur = `Gen${g.pcieGen} x${g.pcieWidth ?? '?'}`;
  return g.pcieGenMax != null ? `${cur} (max Gen${g.pcieGenMax} x${g.pcieWidthMax ?? '?'})` : cur;
}

/** One GPU: gauges, details, utilization and VRAM over time. Hidden or suspended: identity only, nothing is read. */
export function GpuCard({ gpu: g }: { gpu: GpuSample }) {
  const off = g.hidden ? 'hidden' : g.suspended ? 'suspended' : null;
  const vramPct = g.vramTotalBytes > 0 ? (100 * g.vramUsedBytes) / g.vramTotalBytes : 0;
  return (
    <GlassCard
      title={g.name}
      icon={MonitorCog}
      className={off ? 'self-start' : undefined}
      actions={
        <>
          <Badge variant="outline" className="num text-muted-foreground">
            {g.busId}
          </Badge>
          {off && <Badge variant="secondary">{off}</Badge>}
        </>
      }
    >
      {off ? (
        <p className="text-sm text-muted-foreground">
          {g.hidden
            ? 'Card hidden in Settings: it is not read.'
            : 'Card suspended: it is not read, so as not to wake it up.'}
        </p>
      ) : (
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-start gap-6">
            <Gauge label="Utilization" value={Math.round(g.utilPct ?? 0)} size={88} tone="blue" />
            <Gauge
              label={`VRAM ${formatBytes(g.vramUsedBytes, 1)}`}
              value={Math.round(vramPct)}
              size={88}
              tone="teal"
            />
            <div className="min-w-56 flex-1">
              <Facts
                rows={[
                  ['Total VRAM', formatBytes(g.vramTotalBytes)],
                  ['PCIe', pcie(g)],
                  ['PCIe RX / TX', g.pcieRxBps == null ? '—' : `${formatBps(g.pcieRxBps)} / ${formatBps(g.pcieTxBps)}`],
                  [
                    'Power',
                    g.powerLimitW != null ? `${n(g.powerW, 'W')} / ${n(g.powerLimitW, 'W')}` : n(g.powerW, 'W'),
                  ],
                  [
                    'GPU / memory clocks',
                    g.clockGrMhz == null ? '—' : `${n(g.clockGrMhz, 'MHz')} / ${n(g.clockMemMhz, 'MHz')}`,
                  ],
                  ['Temperature', formatTemp(g.tempC)],
                  ['Fan', g.fanPct == null ? '—' : formatPct(g.fanPct)],
                ]}
              />
            </div>
          </div>
          <TimeSeriesChart
            aria-label={`${g.name} utilization and VRAM`}
            height={120}
            yMax={100}
            format={formatPct}
            series={[
              { key: SERIES.gpuUtil(g.key), label: 'Utilization', tone: 'blue' },
              { key: SERIES.gpuVramPct(g.key), label: 'VRAM', tone: 'teal' },
            ]}
          />
        </div>
      )}
    </GlassCard>
  );
}
