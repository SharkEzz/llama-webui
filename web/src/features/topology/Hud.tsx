import {
  type ModelPlacement,
  PHASE_LABEL,
  type Phase,
  type Snapshot,
  type TopologyGraph,
  type TopologyNode,
} from '@llama-webui/shared';
import { ChevronDown, ChevronUp, CircleHelp } from 'lucide-react';
import type { ReactNode } from 'react';
import { GLASS } from '@/components/glass/glass';
import { TONE_VAR, type Tone } from '@/components/glass/tones';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { fmt, formatBytes, formatRate } from '@/lib/format';
import { cn } from '@/lib/utils';
import { FILL_CRIT_PCT, FILL_WARN_PCT, LINK_CRIT, LINK_WARN, p2pSummary, placementSeries } from './flows';
import { useCollapsed } from './hudPrefs';
import { LAYER_TINT } from './themeColors';

/*
 * Glass cards laid over the scene: server phase and model split, both folding down to their title line, and the legend
 * behind a “?” button. Every state is carried by text, never by color alone.
 */

export interface HudProps {
  phase: Phase;
  snapshot: Snapshot | null;
  graph: TopologyGraph | null;
  placement: ModelPlacement | null;
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

interface PanelProps {
  className?: string;
  /** Accessible name of the card, also used by its fold button. */
  label: string;
  /** The card's heading element. */
  title: ReactNode;
  /** Shown beside the title while the card is folded. */
  summary?: ReactNode;
  collapsed: boolean;
  onToggle: () => void;
  /** Stays visible when the card is folded (an error must not be hidden). */
  footer?: ReactNode;
  children: ReactNode;
}

function Panel({ className, label, title, summary, collapsed, onToggle, footer, children }: PanelProps) {
  return (
    <section
      aria-label={label}
      className={cn(GLASS, 'pointer-events-auto absolute z-20 rounded-md px-3.5 py-3 text-sm', className)}
    >
      <div className="flex items-center gap-2">
        {title}
        {collapsed && summary}
        <Button
          variant="ghost"
          size="icon-xs"
          className="-mr-1.5 ml-auto text-muted-foreground"
          aria-expanded={!collapsed}
          aria-label={`${collapsed ? 'Expand' : 'Collapse'} the ${label} card`}
          onClick={onToggle}
        >
          {collapsed ? <ChevronDown aria-hidden="true" /> : <ChevronUp aria-hidden="true" />}
        </Button>
      </div>
      {!collapsed && children}
      {footer}
    </section>
  );
}

/** A lighter shade of a tone: the same mix as the scene's tank layers (see LAYER_TINT), in linear space like Three. */
const tint = (color: string, k: number) => `color-mix(in srgb-linear, ${color}, white ${Math.round(k * 100)}%)`;

export function Hud({ phase, snapshot, graph, placement, tones, reducedMotion, error }: HudProps) {
  const ui = PHASE_UI[phase];
  const [collapsed, toggle] = useCollapsed();
  const series = graph ? placementSeries(graph, placement) : [];
  const total = series.reduce((s, x) => s + x.bytes, 0);
  const colorOf = (nodeId: string | null) => {
    const tone = nodeId ? tones.get(nodeId) : undefined;
    return tone ? TONE_VAR[tone] : 'var(--muted-foreground)';
  };
  const gpuNodes: TopologyNode[] = graph?.nodes.filter((n) => n.kind === 'gpu') ?? [];
  const p2p = p2pSummary(placement);
  const phaseLine = (
    <p className={cn('flex items-center gap-2 font-medium', ui.text)}>
      <span className={cn('size-2 shrink-0 rounded-full', ui.dot)} aria-hidden="true" />
      {PHASE_LABEL[phase]}
    </p>
  );

  return (
    <div className="pointer-events-none absolute inset-0">
      <Panel
        label="Phase"
        className="top-3 left-3 min-w-56"
        title={<h1 className="text-base font-semibold tracking-tight">Topology</h1>}
        summary={phaseLine}
        collapsed={collapsed.phase}
        onToggle={() => toggle('phase')}
        footer={error && <p className="mt-2 text-xs text-destructive">Topology unreadable (API unavailable).</p>}
      >
        <div className="mt-1">{phaseLine}</div>
        <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
          <dt className="text-muted-foreground">Generation</dt>
          <dd className="num text-right">{formatRate(snapshot?.rates.genTps)}</dd>
          <dt className="text-muted-foreground">Prompt</dt>
          <dd className="num text-right">{formatRate(snapshot?.rates.ppTps)}</dd>
        </dl>
      </Panel>

      <Panel
        label="Model split"
        className={cn('top-3 right-3', collapsed.model ? 'min-w-40' : 'w-72')}
        title={<h2 className="text-[0.9375rem] font-semibold tracking-tight">Model</h2>}
        summary={total > 0 && <span className="num text-xs text-muted-foreground">{formatBytes(total)}</span>}
        collapsed={collapsed.model}
        onToggle={() => toggle('model')}
      >
        {series.length === 0 ? (
          <p className="mt-1 text-xs text-muted-foreground">
            {phase === 'stopped'
              ? 'No managed server: split unknown.'
              : phase === 'loading'
                ? 'Loading: the split arrives with the logs.'
                : 'Split unknown: an external server, or a profile whose -lv is below 4 (buffer sizes not logged).'}
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
              {placement?.buffers.some((b) => b.estimated) && ' · estimate (tensor parallel)'}
            </p>
            {p2p && <p className="mt-1 text-xs text-muted-foreground">Peer-to-peer: {p2p}.</p>}
          </>
        )}
      </Panel>

      <Popover>
        <PopoverTrigger
          render={
            <Button
              variant="secondary"
              size="icon-sm"
              className={cn(GLASS, 'pointer-events-auto absolute bottom-3 left-3 z-20 rounded-full')}
              aria-label="Legend"
            />
          }
        >
          <CircleHelp aria-hidden="true" />
        </PopoverTrigger>
        <PopoverContent side="top" align="start" className="w-80 gap-2 px-3.5 py-3">
          <h2 className="text-[0.9375rem] font-semibold tracking-tight">Legend</h2>
          <ul className="space-y-1 text-xs text-muted-foreground">
            <li>Tanks (GPUs, memory): the level is the memory in use.</li>
            <li className="flex flex-wrap items-center gap-x-2.5 gap-y-0.5">
              In a GPU, from the bottom:
              <Swatch color="var(--tone-blue)" label="model" />
              <Swatch color={tint('var(--tone-blue)', LAYER_TINT.kv)} label="KV cache" />
              <Swatch color={tint('var(--tone-blue)', LAYER_TINT.compute)} label="compute" />
              <Swatch color="var(--muted-foreground)" label="other" />
            </li>
            <li>
              A tank's surface turns amber from {FILL_WARN_PCT}% full, red from {FILL_CRIT_PCT}%.
            </li>
            <li>Bar under a name: load. CPU tiles: one per thread, lit with its load.</li>
            <li>Link thickness: PCIe capacity.</li>
            <li>
              Streaks: measured throughput (log scale), one direction per lane. The badge above a block gives its link's
              exact figures, while llama-server works or from 8 MiB/s at rest.
            </li>
            <li>
              Percentage on a badge: share of the link's current capacity, amber from {fmt(LINK_WARN * 100, 0)}%, red
              from {fmt(LINK_CRIT * 100, 0)}%.
            </li>
            <li>
              {snapshot?.system?.memBw
                ? 'CPU ↔ memory: measured DRAM traffic (perf).'
                : 'CPU ↔ memory pulse: CPU activity, for lack of a DRAM measurement (perf).'}
            </li>
            <li>
              Dotted link between GPUs: peer-to-peer (direct transfers), fainter when only requested. Not measured
              apart: its traffic is part of each card's figures.
            </li>
            <li>Hover a block for its details.</li>
          </ul>
          {gpuNodes.length > 0 && (
            <ul className="flex flex-wrap gap-x-3 gap-y-1 text-xs">
              {gpuNodes.map((n) => (
                <li key={n.id}>
                  <Swatch color={colorOf(n.id)} label={n.label} />
                </li>
              ))}
            </ul>
          )}
          {reducedMotion && <p className="text-xs text-muted-foreground">Reduced motion: steady glow, no streaks.</p>}
        </PopoverContent>
      </Popover>
    </div>
  );
}

function Swatch({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-foreground">
      <span className="size-2 rounded-full" style={{ background: color }} aria-hidden="true" />
      {label}
    </span>
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
