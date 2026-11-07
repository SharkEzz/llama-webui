import {
  type ModelPlacement,
  PHASE_LABEL,
  type Phase,
  type Snapshot,
  type TopologyGraph,
  type TopologyNode,
} from '@llama-webui/shared';
import type { ReactNode } from 'react';
import { GLASS } from '@/components/glass/glass';
import { TONE_VAR, type Tone } from '@/components/glass/tones';
import { fmt, formatBps, formatBytes, formatPct, formatRate } from '@/lib/format';
import { cn } from '@/lib/utils';
import { type LinkFlow, placementSeries } from './flows';

/*
 * Glass cards laid over the scene: server phase, model split, legend, aggregate throughput.
 * Every state is carried by text, never by color alone.
 */

export interface HudProps {
  phase: Phase;
  snapshot: Snapshot | null;
  graph: TopologyGraph | null;
  placement: ModelPlacement | null;
  flows: Map<string, LinkFlow> | null;
  tones: Map<string, Tone>;
  reducedMotion: boolean;
  error: boolean;
}

const PHASE_UI: Record<Phase, { dot: string; text: string }> = {
  stopped: { dot: 'bg-muted-foreground/60', text: 'text-muted-foreground' },
  loading: { dot: 'bg-tone-amber animate-pulse', text: 'text-tone-amber' },
  idle: { dot: 'bg-success', text: 'text-success' },
  prompt: { dot: 'bg-tone-blue shadow-[0_0_10px] shadow-tone-blue/60', text: 'text-tone-blue' },
  generating: { dot: 'bg-tone-teal shadow-[0_0_10px] shadow-tone-teal/60', text: 'text-tone-teal' },
};

function Panel({ className, children, label }: { className?: string; children: ReactNode; label: string }) {
  return (
    <section
      aria-label={label}
      className={cn(GLASS, 'pointer-events-auto absolute z-20 rounded-md px-3.5 py-3 text-sm', className)}
    >
      {children}
    </section>
  );
}

export function Hud({ phase, snapshot, graph, placement, flows, tones, reducedMotion, error }: HudProps) {
  const ui = PHASE_UI[phase];
  const series = graph ? placementSeries(graph, placement) : [];
  const total = series.reduce((s, x) => s + x.bytes, 0);
  const colorOf = (nodeId: string | null) => {
    const tone = nodeId ? tones.get(nodeId) : undefined;
    return tone ? TONE_VAR[tone] : 'var(--muted-foreground)';
  };
  const gpuNodes: TopologyNode[] = graph?.nodes.filter((n) => n.kind === 'gpu') ?? [];

  let toGpu: number | null = null;
  let fromGpu: number | null = null;
  let nvme: number | null = null;
  if (graph && flows) {
    const byId = new Map(graph.nodes.map((n) => [n.id, n]));
    for (const l of graph.links) {
      const f = flows.get(l.id);
      const kind = byId.get(l.to)?.kind;
      if (!f) continue;
      if (kind === 'gpu') {
        if (f.fwdBps !== null) toGpu = (toGpu ?? 0) + f.fwdBps;
        if (f.backBps !== null) fromGpu = (fromGpu ?? 0) + f.backBps;
      } else if (kind === 'nvme' && f.backBps !== null) nvme = (nvme ?? 0) + f.backBps; // reads: NVMe → CPU
    }
  }

  return (
    <div className="pointer-events-none absolute inset-0">
      <Panel label="Phase" className="top-3 left-3 min-w-56">
        <h1 className="text-base font-semibold tracking-tight">Topology</h1>
        <p className={cn('mt-1 flex items-center gap-2 font-medium', ui.text)}>
          <span className={cn('size-2 shrink-0 rounded-full', ui.dot)} aria-hidden="true" />
          {PHASE_LABEL[phase]}
        </p>
        <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
          <dt className="text-muted-foreground">Generation</dt>
          <dd className="num text-right">{formatRate(snapshot?.rates.genTps)}</dd>
          <dt className="text-muted-foreground">Prompt</dt>
          <dd className="num text-right">{formatRate(snapshot?.rates.ppTps)}</dd>
        </dl>
      </Panel>

      <Panel label="Model split" className="top-3 right-3 w-72">
        <h2 className="text-[0.9375rem] font-semibold tracking-tight">Model</h2>
        {series.length === 0 ? (
          <p className="mt-1 text-xs text-muted-foreground">
            {phase === 'stopped'
              ? 'No managed server: split unknown.'
              : phase === 'loading'
                ? 'Loading: the split arrives with the logs.'
                : 'Split unknown (external server or logs evicted).'}
          </p>
        ) : (
          <>
            <div
              className="mt-2 flex h-2 w-full overflow-hidden rounded-full bg-well"
              role="img"
              aria-label="Model share per device"
            >
              {series.map((s) => (
                <span
                  key={s.label}
                  style={{ width: `${(100 * s.bytes) / total}%`, background: colorOf(s.nodeId) }}
                  title={`${s.label}: ${formatBytes(s.bytes)}`}
                />
              ))}
            </div>
            <dl className="mt-2 grid grid-cols-[auto_1fr_auto] gap-x-3 gap-y-0.5 text-xs">
              {series.map((s) => (
                <SliceRow
                  key={s.label}
                  label={s.label}
                  bytes={s.bytes}
                  pct={(100 * s.bytes) / total}
                  color={colorOf(s.nodeId)}
                />
              ))}
            </dl>
            <p className="mt-2 text-xs text-muted-foreground">
              <span className="num">{formatBytes(total)}</span>
              {placement?.layers && (
                <>
                  {' · offloaded layers '}
                  <span className="num">
                    {placement.layers.offloaded}/{placement.layers.total}
                  </span>
                </>
              )}
            </p>
          </>
        )}
      </Panel>

      <Panel label="Legend" className="bottom-3 left-3 max-w-64">
        <h2 className="text-[0.9375rem] font-semibold tracking-tight">Legend</h2>
        <ul className="mt-1.5 space-y-0.5 text-xs text-muted-foreground">
          <li>Link thickness: PCIe capacity.</li>
          <li>Particles: measured throughput (log scale), one direction on each side.</li>
          <li>
            {snapshot?.system?.memBw
              ? 'CPU ↔ memory: measured DRAM traffic (perf), writes on one side, reads on the other.'
              : 'CPU ↔ memory pulse: CPU activity, for lack of a DRAM measurement (perf).'}
          </li>
          <li>Glow: load or fill. Hover for details.</li>
        </ul>
        {gpuNodes.length > 0 && (
          <ul className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs">
            {gpuNodes.map((n) => (
              <li key={n.id} className="flex items-center gap-1.5">
                <span className="size-2 rounded-full" style={{ background: colorOf(n.id) }} aria-hidden="true" />
                {n.label}
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel label="Throughput" className="right-3 bottom-3 min-w-56">
        <h2 className="text-[0.9375rem] font-semibold tracking-tight">Throughput</h2>
        <dl className="mt-1.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
          <dt className="text-muted-foreground">Host → GPU</dt>
          <dd className="num text-right">{formatBps(toGpu)}</dd>
          <dt className="text-muted-foreground">GPU → host</dt>
          <dd className="num text-right">{formatBps(fromGpu)}</dd>
          <dt className="text-muted-foreground">NVMe read</dt>
          <dd className="num text-right">{formatBps(nvme)}</dd>
          <dt className="text-muted-foreground">DRAM read</dt>
          <dd className="num text-right">{formatBps(snapshot?.system?.memBw?.readBps)}</dd>
          <dt className="text-muted-foreground">DRAM write</dt>
          <dd className="num text-right">{formatBps(snapshot?.system?.memBw?.writeBps)}</dd>
          <dt className="text-muted-foreground">CPU llama-server</dt>
          <dd className="num text-right">{formatPct(snapshot?.proc?.cpuPct)}</dd>
        </dl>
        {reducedMotion && (
          <p className="mt-2 text-xs text-muted-foreground">Reduced motion: steady glow, no particles.</p>
        )}
        {error && <p className="mt-2 text-xs text-destructive">Topology unreadable (API unavailable).</p>}
      </Panel>
    </div>
  );
}

function SliceRow({ label, bytes, pct, color }: { label: string; bytes: number; pct: number; color: string }) {
  return (
    <>
      <dt className="flex items-center gap-1.5 text-muted-foreground">
        <span className="size-2 rounded-full" style={{ background: color }} aria-hidden="true" />
        {label}
      </dt>
      <dd className="num text-right">{formatBytes(bytes)}</dd>
      <dd className="num text-right text-muted-foreground">{fmt(pct, 1)}%</dd>
    </>
  );
}
