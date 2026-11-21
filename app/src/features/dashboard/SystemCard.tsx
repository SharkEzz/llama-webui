import { type GpuSample, SERIES, type Snapshot } from '@llama-webui/shared';
import { Cpu } from 'lucide-react';
import { Link } from 'react-router';
import { TimeSeriesChart } from '@/components/charts/TimeSeriesChart';
import { Gauge } from '@/components/glass/Gauge';
import { GlassCard } from '@/components/glass/GlassCard';
import type { Tone } from '@/components/glass/tones';
import { formatBps, formatBytes, formatPct, formatTemp, num } from '@/lib/format';
import { cn } from '@/lib/utils';

const GPU_TONES: Tone[] = ['amber', 'rose', 'blue', 'teal'];
const WELL = 'rounded-md bg-well inset-shadow-well';
const short = (name: string) => name.replace(/^NVIDIA GeForce /, '').replace(/^Radeon /, '');
const pct = (used: number, total: number) => (total > 0 ? Math.round((100 * used) / total) : 0);
const round = (v: number | null | undefined) => (v == null || !Number.isFinite(v) ? 0 : Math.round(v));

/**
 * Load of the machine: CPU, RAM, VRAM of the server's GPUs (every GPU read when no server) and the reads of the
 * model's disk. One meter per resource; the grid fits as many columns as the card is wide, so the same card is a
 * row under the "stopped" notice and a column beside the Dashboard charts.
 */
export function SystemCard({ snapshot, className }: { snapshot: Snapshot | null; className?: string }) {
  const sys = snapshot?.system;
  const mem = sys?.mem;
  const memUsed = mem ? mem.totalBytes - mem.availableBytes : 0;
  const gpus = snapshot
    ? snapshot.gpus.length > 0
      ? snapshot.gpus
      : snapshot.allGpus.filter((g) => !g.hidden && !g.suspended)
    : [];

  return (
    <GlassCard
      title="System"
      icon={Cpu}
      actions={
        <Link
          to="/system"
          className="rounded-sm text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
        >
          All readings
        </Link>
      }
      className={className}
      contentClassName="flex flex-1 flex-col gap-3"
    >
      <div className="grid flex-1 grid-cols-[repeat(auto-fit,minmax(13.5rem,1fr))] gap-3">
        <Meter
          label="CPU"
          value={round(sys?.cpuPct)}
          tone="blue"
          series={SERIES.sysCpu}
          lines={[
            sys?.tempC == null ? null : formatTemp(sys.tempC),
            sys?.load ? `Load average ${num(2).format(sys.load[0])}` : null,
          ]}
        />
        <Meter
          label="RAM"
          value={mem ? pct(memUsed, mem.totalBytes) : 0}
          tone="teal"
          series={SERIES.sysMemPct}
          lines={[
            mem ? `${formatBytes(memUsed, 0)} / ${formatBytes(mem.totalBytes, 0)}` : null,
            mem ? `${formatBytes(mem.cachedBytes, 0)} cached` : null,
          ]}
        />
        {gpus.map((g, i) => (
          <Meter
            key={g.key}
            label={`VRAM ${short(g.name)}`}
            value={pct(g.vramUsedBytes, g.vramTotalBytes)}
            tone={GPU_TONES[i % GPU_TONES.length]!}
            series={SERIES.gpuVramPct(g.key)}
            lines={[`${formatBytes(g.vramUsedBytes)} / ${formatBytes(g.vramTotalBytes)}`, gpuActivity(g)]}
          />
        ))}
      </div>
      <DiskReads disk={snapshot?.disk ?? null} />
    </GlassCard>
  );
}

/** "Load 43%, 61 °C": what the card reports of its compute load and temperature. */
function gpuActivity(g: GpuSample): string | null {
  const parts = [
    g.utilPct == null ? null : `Load ${formatPct(g.utilPct)}`,
    g.tempC == null ? null : formatTemp(g.tempC),
  ].filter((p) => p !== null);
  return parts.length > 0 ? parts.join(', ') : null;
}

interface MeterProps {
  label: string;
  value: number;
  tone: Tone;
  /** History series of the same percentage, drawn under the readings when the cell has height to spare. */
  series: string;
  /** Detail lines under the label; null entries are skipped. */
  lines: (string | null)[];
}

/**
 * One resource: its gauge, its name and up to two lines of detail. Beside the charts the card is as tall as the
 * window allows: the height a cell gets beyond its readings goes to the history of its percentage, and a cell with
 * no room to spare (a short window, the full-width row) shows the readings alone.
 */
function Meter({ label, value, tone, series, lines }: MeterProps) {
  return (
    <div className={cn(WELL, 'flex min-w-0 flex-col px-2.5 py-2')}>
      <div className="flex min-w-0 items-center gap-2.5">
        <Gauge label={label} value={value} size={56} tone={tone} caption={false} />
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="truncate text-sm font-medium" title={label}>
            {label}
          </span>
          {lines.map(
            (line) =>
              line && (
                <span key={line} className="truncate num text-[0.6875rem] leading-4 text-muted-foreground">
                  {line}
                </span>
              ),
          )}
        </div>
      </div>
      {/* A size container: it takes the spare height without asking for any, and hides a history too flat to read. */}
      <div className="min-h-0 flex-1 [container-type:size]">
        <div className="invisible flex h-full flex-col pt-2 [@container(min-height:2.5rem)]:visible">
          <TimeSeriesChart
            aria-label={`${label} over the history`}
            compact
            fill
            yMax={100}
            className="min-h-0"
            series={[{ key: series, label, tone }]}
          />
        </div>
      </div>
    </div>
  );
}

/** Reads of the model's disk (of every disk when it is unknown): the current rate and its recent history. */
function DiskReads({ disk }: { disk: Snapshot['disk'] }) {
  const model = disk?.model;
  return (
    <div className={cn(WELL, 'flex items-center gap-4 px-3 py-2')}>
      <div className="flex min-w-0 shrink-0 flex-col gap-0.5">
        <span className="text-sm font-medium">{model ? 'Model disk' : 'Disks'}</span>
        <span className="truncate num text-xs text-muted-foreground">{model ? model.disk : 'All disks'}</span>
      </div>
      <TimeSeriesChart
        aria-label={model ? `Reads of the model disk (${model.disk})` : 'Reads of all disks'}
        compact
        height={40}
        className="flex-1"
        series={[{ key: model ? SERIES.modelDiskRead : SERIES.diskRead, label: 'Read', tone: 'amber' }]}
      />
      <div className="flex shrink-0 flex-col items-end gap-0.5">
        <span className="num text-sm font-medium">{disk ? formatBps(model?.readBps ?? disk.readBps) : '—'}</span>
        <span className="text-xs text-muted-foreground">read</span>
      </div>
    </div>
  );
}
