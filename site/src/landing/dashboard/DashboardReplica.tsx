import { Cpu, Layers, ListOrdered, TextCursorInput, Zap } from 'lucide-react';
import { dec, formatGiB, formatInt, formatPct } from '@/lib/format';
import { cn } from '@/lib/utils';
import { clock, type Frame } from '../telemetry';
import { Gauge } from './Gauge';
import { Panel, StatTile } from './Panel';
import { THROUGHPUT, ThroughputChart, ThroughputLegend, type ThroughputSeries } from './ThroughputChart';
import { TONE_VAR, type Tone } from './tones';

const GPU_TONES: Tone[] = ['amber', 'rose'];
const SERIES: ThroughputSeries[] = ['gen', 'pp'];
const WELL = 'rounded-md bg-well inset-shadow-well';

/**
 * The Dashboard page of the app (web/src/features/dashboard/DashboardPage.tsx), drawn from a simulated frame.
 * Responsive to its container (the hero window), not the viewport: tiles and the two throughput charts on small
 * widths, the full page from @3xl, charts and system card side by side from @5xl.
 */
export function DashboardReplica({ frame }: { frame: Frame }) {
  const ctxPct = (100 * frame.ctxUsed) / frame.ctxTotal;
  const busy = frame.phase !== 'idle';
  const ramPct = (100 * frame.ramUsedGiB) / frame.ramTotalGiB;

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

      <div className="grid gap-4 @5xl:grid-cols-[minmax(0,3fr)_minmax(30.5rem,2fr)]">
        <div className="grid gap-4">
          {SERIES.map((series) => (
            <Panel
              key={series}
              title={THROUGHPUT[series].title}
              icon={series === 'gen' ? Zap : TextCursorInput}
              actions={<ThroughputLegend history={frame.history} series={series} />}
            >
              <ThroughputChart history={frame.history} series={series} />
            </Panel>
          ))}
        </div>
        <Panel
          title="System"
          icon={Cpu}
          actions={<span className="text-xs font-normal tracking-normal text-muted-foreground">All readings</span>}
          className="hidden @3xl:flex"
        >
          <div className="grid flex-1 grid-cols-[repeat(auto-fit,minmax(13.5rem,1fr))] gap-3">
            <Meter label="CPU" value={frame.cpuPct} tone="blue" lines={[]} history={frame.history.map((p) => p.cpu)} />
            <Meter
              label="RAM"
              value={ramPct}
              tone="teal"
              lines={[`${formatGiB(frame.ramUsedGiB, 0)} / ${formatGiB(frame.ramTotalGiB, 0)}`]}
              history={frame.history.map(() => ramPct)}
            />
            {frame.gpus.map((g, i) => {
              // The model stays loaded for the whole replayed session: its VRAM does not move.
              const vramPct = (100 * g.vramUsedGiB) / g.vramTotalGiB;
              return (
                <Meter
                  key={g.name}
                  label={`VRAM ${g.name}`}
                  value={vramPct}
                  tone={GPU_TONES[i % GPU_TONES.length] ?? 'amber'}
                  lines={[`${formatGiB(g.vramUsedGiB)} / ${formatGiB(g.vramTotalGiB)}`, `Load ${formatPct(g.utilPct)}`]}
                  history={frame.history.map(() => vramPct)}
                />
              );
            })}
          </div>
          {/* The replayed session reads nothing from the disk once the model is loaded: a flat line at 0. */}
          <div className={cn(WELL, 'flex items-center gap-4 px-3 py-2')}>
            <div className="flex shrink-0 flex-col gap-0.5">
              <span className="text-sm font-medium">Model disk</span>
              <span className="num text-xs text-muted-foreground">nvme0n1</span>
            </div>
            <div className="flex h-10 flex-1 items-end pb-0.5">
              <span className="h-0.5 w-full rounded-full bg-(--tone-amber)" />
            </div>
            <div className="flex shrink-0 flex-col items-end gap-0.5">
              <span className="num text-sm font-medium">0 B/s</span>
              <span className="text-xs text-muted-foreground">read</span>
            </div>
          </div>
        </Panel>
      </div>

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

interface MeterProps {
  label: string;
  value: number;
  tone: Tone;
  lines: string[];
  /** The same percentage over the history, oldest first. */
  history: number[];
}

/**
 * One resource of the app's System card (web/src/features/dashboard/SystemCard.tsx): gauge, name, detail lines, and
 * the history of its percentage in the height the cell has to spare.
 */
function Meter({ label, value, tone, lines, history }: MeterProps) {
  return (
    <div className={cn(WELL, 'flex min-w-0 flex-col px-2.5 py-2')}>
      <div className="flex min-w-0 items-center gap-2.5">
        <Gauge label={label} value={value} size={56} tone={tone} caption={false} />
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="truncate text-sm font-medium">{label}</span>
          {lines.map((line) => (
            <span key={line} className="num truncate text-[0.6875rem] leading-4 text-muted-foreground">
              {line}
            </span>
          ))}
        </div>
      </div>
      {/* A size container, as in the app: it takes the spare height and hides a history too flat to read. */}
      <div className="min-h-0 flex-1 [container-type:size]">
        <div className="invisible h-full pt-2 [@container(min-height:2.5rem)]:visible">
          <Sparkline values={history} tone={tone} />
        </div>
      </div>
    </div>
  );
}

/** A percentage (0 to 100) over the history, like the app's compact chart: 2 px line, 10 % fill, no axes. */
function Sparkline({ values, tone }: { values: number[]; tone: Tone }) {
  const n = Math.max(1, values.length - 1);
  const line = `M${values.map((v, i) => `${((100 * i) / n).toFixed(1)},${(100 - v).toFixed(1)}`).join('L')}`;
  const color = TONE_VAR[tone];
  return (
    <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="size-full overflow-visible" aria-hidden="true">
      <path d={`${line}L100,100L0,100Z`} fill={color} fillOpacity={0.1} />
      <path
        d={line}
        fill="none"
        stroke={color}
        strokeWidth={2}
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
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
