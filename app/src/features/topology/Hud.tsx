import {
  type LoadProgress,
  loadProgressPct,
  loadStageLabel,
  type ModelPlacement,
  PHASE_LABEL,
  type Phase,
  type Snapshot,
  type TopologyGraph,
  type TopologyNode,
} from '@llama-webui/shared';
import { CircleHelp } from 'lucide-react';
import { GLASS } from '@/components/glass/glass';
import { TONE_VAR, type Tone } from '@/components/glass/tones';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { fmt, formatBytes, formatPct, formatRate } from '@/lib/format';
import { cn } from '@/lib/utils';
import { FILL_CRIT_PCT, FILL_WARN_PCT, LINK_CRIT, LINK_WARN, p2pSummary, placementSeries } from './flows';
import { LAYER_TINT, tint } from './themeColors';
import type { TopologyView } from './viewPrefs';

/*
 * The side column's cards: server phase, model split, and the legend behind its button. Every state is carried by
 * text, never by color alone.
 */

export interface HudProps {
  phase: Phase;
  loadProgress?: LoadProgress | null;
  snapshot: Snapshot | null;
  graph: TopologyGraph | null;
  placement: ModelPlacement | null;
  tones: Map<string, Tone>;
  error: boolean;
}

export interface LegendProps {
  snapshot: Snapshot | null;
  graph: TopologyGraph | null;
  tones: Map<string, Tone>;
  view: TopologyView;
  reducedMotion: boolean;
}

const PHASE_UI: Record<Phase, { dot: string; text: string }> = {
  stopped: { dot: 'bg-muted-foreground/60', text: 'text-muted-foreground' },
  loading: { dot: 'bg-tone-amber animate-pulse', text: 'text-tone-amber' },
  sleeping: { dot: 'bg-tone-blue/70', text: 'text-tone-blue' },
  idle: { dot: 'bg-success', text: 'text-success' },
  prompt: { dot: 'bg-tone-blue shadow-[0_0_10px] shadow-tone-blue/60', text: 'text-tone-blue' },
  generating: { dot: 'bg-tone-teal shadow-[0_0_10px] shadow-tone-teal/60', text: 'text-tone-teal' },
};

const PANEL = cn(GLASS, 'rounded-md px-3.5 py-3 text-sm');
const TITLE = 'text-[0.9375rem] font-semibold tracking-tight';

/** Color of a device of the model split, or of a GPU of the legend: the tone of its block. */
function colorOf(tones: Map<string, Tone>, nodeId: string | null): string {
  const tone = nodeId ? tones.get(nodeId) : undefined;
  return tone ? TONE_VAR[tone] : 'var(--muted-foreground)';
}

export function Hud({ phase, loadProgress = null, snapshot, graph, placement, tones, error }: HudProps) {
  const ui = PHASE_UI[phase];
  const series = graph ? placementSeries(graph, placement) : [];
  const total = series.reduce((s, x) => s + x.bytes, 0);
  const p2p = p2pSummary(placement);
  const loadPct = phase === 'loading' && loadProgress ? loadProgressPct(loadProgress) : null;

  return (
    <>
      <section aria-label="Phase" className={PANEL}>
        <h2 className={TITLE}>Phase</h2>
        <p className={cn('mt-1 flex items-center gap-2 font-medium', ui.text)}>
          <span className={cn('size-2 shrink-0 rounded-full', ui.dot)} aria-hidden="true" />
          {PHASE_LABEL[phase]}
          {phase === 'loading' && loadProgress && (
            <span className="num text-xs opacity-80">
              {loadStageLabel(loadProgress.current)}
              {loadPct !== null ? ` ${formatPct(loadPct)}` : ''}
            </span>
          )}
        </p>
        <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
          <dt className="text-muted-foreground">Generation</dt>
          <dd className="text-right num">{formatRate(snapshot?.rates.genTps)}</dd>
          <dt className="text-muted-foreground">Prompt</dt>
          <dd className="text-right num">{formatRate(snapshot?.rates.ppTps)}</dd>
        </dl>
        {error && <p className="mt-2 text-xs text-destructive">Topology unreadable (API unavailable).</p>}
      </section>

      <section aria-label="Model split" className={PANEL}>
        <h2 className={TITLE}>Model</h2>
        {series.length === 0 ? (
          <p className="mt-1 text-xs text-muted-foreground">
            {phase === 'stopped'
              ? 'No managed server: split unknown.'
              : phase === 'loading'
                ? 'Loading: the split arrives with the logs.'
                : phase === 'sleeping'
                  ? 'Model is sleeping: VRAM released until the next request.'
                  : 'Split unknown: an external server without /models/sse, or a profile whose -lv is below 4.'}
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
                  style={{ width: `${(100 * s.bytes) / total}%`, background: colorOf(tones, s.nodeId) }}
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
                  color={colorOf(tones, s.nodeId)}
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
              {placement?.source === 'sse' && !placement.layers && ' · from /models/sse'}
            </p>
            {p2p && <p className="mt-1 text-xs text-muted-foreground">Peer-to-peer: {p2p}.</p>}
          </>
        )}
      </section>
    </>
  );
}

export function Legend({ snapshot, graph, tones, view, reducedMotion }: LegendProps) {
  const gpuNodes: TopologyNode[] = graph?.nodes.filter((n) => n.kind === 'gpu') ?? [];
  return (
    <Popover>
      <PopoverTrigger
        render={<Button variant="secondary" size="sm" className={cn(GLASS, 'self-start justify-self-start')} />}
      >
        <CircleHelp aria-hidden="true" />
        Legend
      </PopoverTrigger>
      <PopoverContent side="top" align="start" className="w-80 gap-2 px-3.5 py-3">
        <h2 className={TITLE}>Legend</h2>
        <ul className="space-y-1 text-xs text-muted-foreground">
          <li>Wide bar of a GPU or of the memory: the memory in use.</li>
          <li className="flex flex-wrap items-center gap-x-2.5 gap-y-0.5">
            In a GPU, in this order:
            <Swatch color="var(--tone-blue)" label="model" />
            <Swatch color={tint('var(--tone-blue)', LAYER_TINT.kv)} label="KV cache" />
            <Swatch color={tint('var(--tone-blue)', LAYER_TINT.compute)} label="compute" />
            <Swatch color="var(--muted-foreground)" label="other" />
          </li>
          <li>
            The bar is outlined and its figure turns amber from {FILL_WARN_PCT}% full, red from {FILL_CRIT_PCT}%.
          </li>
          <li>Thin bar: load. CPU tiles: one per thread, lit with its load.</li>
          <li>Link thickness: PCIe capacity.</li>
          <li>
            Streaks: measured throughput (log scale), one direction per lane. The label of a link gives its current
            state and its exact figures. At rest, a link shows its traffic only from 8 MiB/s.
          </li>
          <li>
            Percentage on a label: share of the link&apos;s current capacity, amber from {fmt(LINK_WARN * 100, 0)}%, red
            from {fmt(LINK_CRIT * 100, 0)}%.
          </li>
          <li>
            {snapshot?.system?.memBw
              ? 'CPU ↔ memory: measured DRAM traffic (perf).'
              : 'CPU ↔ memory: the link follows the CPU activity, without streaks, for lack of a DRAM measurement (perf).'}
          </li>
          <li>
            Dotted link between GPUs: peer-to-peer (direct transfers), fainter when only requested. Not measured apart:
            its traffic is part of each card&apos;s figures.
          </li>
          <li>Select a block for its details.</li>
          <li>The wheel zooms, a drag moves the drawing; the buttons at its lower right zoom and reset.</li>
          {view === 'board' && <li>The board is a convention, not a picture of this motherboard.</li>}
        </ul>
        {gpuNodes.length > 0 && (
          <ul className="flex flex-wrap gap-x-3 gap-y-1 text-xs">
            {gpuNodes.map((n) => (
              <li key={n.id}>
                <Swatch color={colorOf(tones, n.id)} label={n.label} />
              </li>
            ))}
          </ul>
        )}
        {reducedMotion && (
          <p className="text-xs text-muted-foreground">Reduced motion: no streaks, a busy link is dashed.</p>
        )}
      </PopoverContent>
    </Popover>
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
      <dd className="text-right num">{formatBytes(bytes)}</dd>
      <dd className="text-right num text-muted-foreground">{fmt(pct, 1)}%</dd>
    </>
  );
}
