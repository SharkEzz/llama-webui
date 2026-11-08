import { Layers, ListOrdered, Zap } from 'lucide-react';
import { dec, formatGiB, formatInt, formatPct } from '@/lib/format';
import { cn } from '@/lib/utils';
import { clock, type Frame } from '../telemetry';
import { Gauge } from './Gauge';
import { PANEL, Panel, StatTile } from './Panel';
import { ThroughputChart } from './ThroughputChart';
import type { Tone } from './tones';

const GPU_TONES: Tone[] = ['amber', 'rose'];

/**
 * The Dashboard page of the app (web/src/features/dashboard/DashboardPage.tsx), drawn from a simulated frame.
 * Responsive to its container (the hero window), not the viewport: tiles and chart on small widths, the full page
 * from @3xl, throughput and context side by side from @5xl.
 */
export function DashboardReplica({ frame }: { frame: Frame }) {
  const ctxPct = (100 * frame.ctxUsed) / frame.ctxTotal;
  const busy = frame.phase !== 'idle';

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <h1 className="text-2xl font-semibold tracking-tight @3xl:text-3xl">Dashboard</h1>
        <StateBadge />
      </div>

      <div className="grid grid-cols-2 gap-3 @5xl:grid-cols-4 @5xl:gap-4">
        <StatTile label="Generation" value={dec(frame.genTps)} unit="tok/s" tone="var(--tone-blue)" />
        <StatTile label="Prompt" value={dec(frame.ppTps)} unit="tok/s" tone="var(--tone-teal)" />
        <StatTile
          label="Speculative acceptance"
          value={formatPct(frame.acceptPct)}
          hint={`${dec(frame.tokensPerDraft)} tokens accepted per draft`}
          tone="var(--tone-amber)"
        />
        <StatTile
          label="Context used"
          value={formatPct(ctxPct)}
          hint={`${formatInt(frame.ctxUsed)} / ${formatInt(frame.ctxTotal)} tokens`}
          tone="var(--tone-rose)"
        />
      </div>

      <div className={cn(PANEL, 'hidden flex-wrap items-start justify-around gap-x-6 gap-y-4 p-4 @3xl:flex')}>
        <Gauge label="CPU" value={frame.cpuPct} tone="blue" />
        <Gauge
          label={`RAM ${formatGiB(frame.ramUsedGiB, 0)} / ${formatGiB(frame.ramTotalGiB, 0)}`}
          value={(100 * frame.ramUsedGiB) / frame.ramTotalGiB}
          tone="teal"
        />
        {frame.gpus.map((g, i) => (
          <Gauge
            key={g.name}
            label={`VRAM ${g.name}`}
            value={(100 * g.vramUsedGiB) / g.vramTotalGiB}
            tone={GPU_TONES[i % GPU_TONES.length]}
          />
        ))}
        <div className="flex min-w-32 flex-col gap-1 self-center text-sm">
          <span className="text-xs text-muted-foreground">Model disk (nvme0n1)</span>
          <span className="num">0 B/s</span>
          <span className="text-xs text-muted-foreground">read</span>
        </div>
      </div>

      <div className="grid gap-4 @5xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <Panel title="Throughput (tok/s)" icon={Zap}>
          <ThroughputChart history={frame.history} />
        </Panel>
        <Panel title="Slots and context" icon={Layers} className="hidden @3xl:flex">
          <div className="flex flex-col gap-1.5">
            <div className="flex items-baseline gap-2 text-sm">
              <span className="font-medium">Slot 0</span>
              <span
                className={cn(
                  'inline-flex h-5 items-center rounded-4xl px-2 text-xs font-medium',
                  busy ? 'bg-secondary text-success' : 'border border-border text-muted-foreground',
                )}
              >
                {busy ? 'busy' : 'free'}
              </span>
              <span className="num ml-auto text-xs text-muted-foreground">
                {formatInt(frame.ctxUsed)} / {formatInt(frame.ctxTotal)} ({formatPct(ctxPct)})
              </span>
            </div>
            <div className="h-1 overflow-hidden rounded-full bg-muted">
              <div className="h-full bg-primary transition-[width] duration-700" style={{ width: `${ctxPct}%` }} />
            </div>
          </div>
          <dl className="grid grid-cols-3 gap-2 border-t border-border pt-4 text-sm">
            <QueueStat label="Processing" value={busy ? 1 : 0} />
            <QueueStat label="Queued" value={0} />
            <QueueStat label="Busy slots" value={busy ? 1 : 0} />
          </dl>
        </Panel>
      </div>

      <Panel title="Recent requests" icon={ListOrdered} className="hidden @3xl:flex">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-border">
              {['Time', 'Prompt', 'Cache', 'Generated', 'Duration (s)', 'Prompt tok/s', 'Generation tok/s'].map(
                (h, i) => (
                  <th key={h} className={cn('h-9 px-2 font-medium whitespace-nowrap', i > 0 && 'text-right')}>
                    {h}
                  </th>
                ),
              )}
              <th className="h-9 px-2 text-right font-medium">Acceptance</th>
            </tr>
          </thead>
          <tbody className="num">
            {frame.requests.map((r) => (
              <tr key={r.id} className="border-b border-border last:border-0">
                <td className="p-2">{clock(r.at)}</td>
                <td className="p-2 text-right">{formatInt(r.prompt)}</td>
                <td className="p-2 text-right">{formatInt(r.cached)}</td>
                <td className="p-2 text-right">{formatInt(r.generated)}</td>
                <td className="p-2 text-right">{dec(r.durationSec, 2)}</td>
                <td className="p-2 text-right">{dec(r.ppTps)}</td>
                <td className="p-2 text-right">{dec(r.genTps)}</td>
                <td className="p-2 text-right">{formatPct(r.acceptPct)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
    </div>
  );
}

export function StateBadge() {
  return (
    <span className="inline-flex items-center gap-2 text-sm font-medium text-success">
      <span className="size-2 shrink-0 rounded-full bg-success shadow-[0_0_10px] shadow-success/60" />
      Ready
    </span>
  );
}

function QueueStat({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="num text-lg">{value}</dd>
    </div>
  );
}
