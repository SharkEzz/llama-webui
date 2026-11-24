import { Tooltip as TooltipPrimitive } from '@base-ui/react/tooltip';
import type { TopologyNode, TopologyNodeKind } from '@llama-webui/shared';
import React, { useCallback, useMemo, type CSSProperties, type ReactNode } from 'react';
import { GLASS } from '@/components/glass/glass';
import type { Tone } from '@/components/glass/tones';
import { PopoverTrigger } from '@/components/ui/popover';
import { formatPct } from '@/lib/format';
import { cn } from '@/lib/utils';
import { detailPopover } from './detailPopover';
import type { LayerKind, Level, NodeLive } from './flows';
import type { Rect } from './geometry';
import { encodeLayerTarget, layerTooltip } from './layerTooltip';
import { LAYER_TINT, tint } from './themeColors';

/*
 * What the blocks of both views are made of. A block is a button: a click, Enter or Space opens its details, and its
 * text is its name for a screen reader. Its values change with each sample and ease by CSS transitions in a few steps,
 * never by script.
 */

/** A block's color: a GPU's data tone, or the one of its kind. */
export type BlockTone = Tone | 'indigo' | 'primary' | 'neutral';

/** A block's kind, in words. */
export const KIND_LABEL = {
  cpu: 'Processor',
  ram: 'Memory',
  gpu: 'GPU',
  nvme: 'NVMe drive',
  chipset: 'Chipset',
} as const satisfies Record<TopologyNodeKind, string>;

const TONE_CSS = {
  blue: 'var(--tone-blue)',
  teal: 'var(--tone-teal)',
  amber: 'var(--tone-amber)',
  rose: 'var(--tone-rose)',
  indigo: 'var(--tone-indigo)',
  primary: 'var(--primary-ink)',
  neutral: 'var(--muted-foreground)',
} as const satisfies Record<BlockTone, string>;

export const toneVar = (tone: BlockTone) => TONE_CSS[tone];

export function toneOfNode(node: TopologyNode, tones: Map<string, Tone>): BlockTone {
  if (node.kind === 'gpu') return tones.get(node.id) ?? 'neutral';
  return node.kind === 'cpu' ? 'primary' : node.kind === 'ram' ? 'indigo' : 'neutral';
}

/** A change of value takes half a second in five steps: a few repaints, not an animation. */
const STEPPED = 'transition-transform duration-500 ease-[steps(5,end)] motion-reduce:transition-none';

const LEVEL_TEXT: Record<Level, string> = { ok: '', warn: 'text-warning', crit: 'text-destructive' };
const LEVEL_RING: Record<Level, string> = { ok: '', warn: 'ring-2 ring-warning', crit: 'ring-2 ring-destructive' };

/** A fact of the block by its label (the temperature, the power…); null when the sample does not have it. */
export const factOf = (live: NodeLive, label: string) => live.facts.find((f) => f.label === label)?.value ?? null;

interface BlockProps {
  node: TopologyNode;
  live: NodeLive;
  rect: Rect;
  tone: BlockTone;
  /** No glass surface of its own: the block is made of parts that have theirs (the memory modules of the board). */
  bare?: boolean;
  className?: string;
  children: ReactNode;
}

/**
 * A block at its rectangle: a button that opens its details beside it, outlined while they are open. Its content is
 * phrasing content (spans).
 */
export function Block({ node, live, rect, tone, bare = false, className, children }: BlockProps) {
  const style: CSSProperties & { '--tone': string } = {
    left: rect.x,
    top: rect.y,
    width: rect.w,
    height: rect.h,
    '--tone': toneVar(tone),
  };
  return (
    <PopoverTrigger
      handle={detailPopover}
      payload={node.id}
      data-node={node.id}
      style={style}
      className={cn(
        'absolute cursor-pointer text-left text-foreground',
        bare
          ? 'rounded-lg outline-offset-4 outline-primary-ink focus-visible:outline-2 data-popup-open:outline-2'
          : [
              GLASS,
              'transition-shadow outline-none hover:ring-surface-border-bright focus-visible:ring-2 focus-visible:ring-ring',
              'data-popup-open:ring-2 data-popup-open:ring-primary-ink',
            ],
        live.dim && 'opacity-60',
        className,
      )}
    >
      {children}
    </PopoverTrigger>
  );
}

const NEUTRAL = 'var(--muted-foreground)';
const LAYER_COLOR: Record<LayerKind, string> = {
  model: 'var(--tone)',
  kv: tint('var(--tone)', LAYER_TINT.kv),
  compute: tint('var(--tone)', LAYER_TINT.compute),
  other: NEUTRAL,
  used: 'var(--tone)',
};

/** The four layers a GPU can hold, always in the DOM so that one appearing eases in like the others. */
const GPU_LAYERS: readonly LayerKind[] = ['model', 'kv', 'compute', 'other'];

/** Color of a memory layer for use outside a block (tooltips, swatches), matching `Layers`. */
export function layerSwatchColor(kind: LayerKind, tone: BlockTone, neutral = false): string {
  if (kind === 'other' || (neutral && kind === 'used')) return NEUTRAL;
  const base = toneVar(tone);
  if (kind === 'kv') return tint(base, LAYER_TINT.kv);
  if (kind === 'compute') return tint(base, LAYER_TINT.compute);
  return base;
}

/**
 * The memory a block holds, as stacked layers: each one is a full-size bar moved and scaled by a transform, so a
 * change never lays the block out again. The level is also in the figure beside it (see `FillPct`).
 */
export function Layers({
  live,
  nodeId,
  vertical = false,
  neutral = false,
  className,
}: {
  live: NodeLive;
  /** When set (GPUs), each layer and the free remainder trigger the shared VRAM tooltip on hover. */
  nodeId?: string;
  vertical?: boolean;
  /** A GPU whose split is not known: its memory in use is gray, since its tone stands for the model. */
  neutral?: boolean;
  className?: string;
}) {
  const single = live.layers.length <= 1;
  const kinds = useMemo(() => (single ? [live.layers[0]?.kind ?? 'used'] : GPU_LAYERS), [single, live.layers]);
  const shares = useMemo(
    () => kinds.map((kind) => (live.layers.find((l) => l.kind === kind)?.pct ?? 0) / 100),
    [kinds, live.layers],
  );
  const usedShare = useMemo(() => shares.reduce((a, b) => a + b, 0), [shares]);
  const freeShare = live.capacityBytes !== null && live.capacityBytes > 0 ? Math.max(0, 1 - usedShare) : 0;
  const segmentTransform = useCallback(
    (at: number, share: number) =>
      vertical
        ? `translateY(${(-at * 100).toFixed(2)}%) scaleY(${share.toFixed(4)})`
        : `translateX(${(at * 100).toFixed(2)}%) scaleX(${share.toFixed(4)})`,
    [vertical],
  );

  const parts = useMemo((): React.ReactNode[] => {
    const elements = kinds.map((kind, i) => {
      const share = shares[i];
      if (share == null) {
        throw new Error(`Share not found for kind: "${kind}"`);
      }
      const at = shares.slice(0, i).reduce((a, b) => a + b, 0);
      const style = {
        transform: segmentTransform(at, share),
        background: neutral && kind === 'used' ? NEUTRAL : LAYER_COLOR[kind],
      };
      const baseClass = cn('absolute inset-0', vertical ? 'origin-bottom' : 'origin-left', STEPPED);
      if (!nodeId) return <span key={kind} className={baseClass} style={style} />;
      const empty = !(share > 0);
      return (
        <TooltipPrimitive.Trigger
          key={kind}
          handle={layerTooltip}
          payload={encodeLayerTarget(nodeId, kind)}
          disabled={empty}
          render={<span />}
          className={cn(baseClass, empty ? 'pointer-events-none' : 'data-popup-open:brightness-125')}
          style={style}
        />
      );
    });

    return elements;
  }, [kinds, shares, vertical, nodeId, segmentTransform, neutral]);

  return (
    <span
      aria-hidden="true"
      className={cn('relative block overflow-hidden bg-well inset-shadow-well', LEVEL_RING[live.fillLevel], className)}
    >
      {parts}
      {nodeId && (
        <TooltipPrimitive.Trigger
          handle={layerTooltip}
          payload={encodeLayerTarget(nodeId, 'free')}
          disabled={!(freeShare > 0)}
          render={<span />}
          className={cn(
            'absolute inset-0',
            vertical ? 'origin-bottom' : 'origin-left',
            STEPPED,
            !(freeShare > 0) ? 'pointer-events-none' : 'data-popup-open:bg-foreground/10',
          )}
          style={{ transform: segmentTransform(usedShare, freeShare) }}
        />
      )}
    </span>
  );
}

/** A fill as a figure, in the color of its level: the level is never carried by the bar's outline alone. */
export function FillPct({ live, className }: { live: NodeLive; className?: string }) {
  if (live.fillPct === null) return null;
  const word = live.fillLevel === 'crit' ? ' (full)' : live.fillLevel === 'warn' ? ' (nearly full)' : '';
  return (
    <span className={cn('num', LEVEL_TEXT[live.fillLevel], className)}>
      {formatPct(live.fillPct)}
      {word && <span className="sr-only">{word}</span>}
    </span>
  );
}

/** A load (0..100) as a thin bar. */
export function LoadBar({ pct, className }: { pct: number | null; className?: string }) {
  const share = Math.max(0, Math.min(1, (pct ?? 0) / 100));
  return (
    <span
      aria-hidden="true"
      className={cn('block h-1.5 overflow-hidden rounded-full bg-well inset-shadow-well', className)}
    >
      <span
        className={cn('block h-full origin-left bg-(--tone)', STEPPED)}
        style={{ transform: `scaleX(${share.toFixed(4)})` }}
      />
    </span>
  );
}

/** One tile per CPU thread, lit with its load. `count`: the threads of the CPU, before the first sample gives them. */
export function Threads({
  cores,
  count,
  columns,
  className,
}: {
  cores: readonly number[];
  count: number;
  columns: number;
  className?: string;
}) {
  const tiles = cores.length > 0 ? cores : Array.from({ length: count }, () => 0);
  return (
    <span
      aria-hidden="true"
      className={cn('grid gap-0.75', className)}
      style={{ gridTemplateColumns: `repeat(${Math.max(1, columns)}, minmax(0, 1fr))` }}
    >
      {tiles.map((pct, i) => (
        // oxlint-disable-next-line react/no-array-index-key -- a thread has no identity but its position
        <span key={i} className="relative overflow-hidden rounded-[3px] bg-foreground/10">
          <span
            className="absolute inset-0 bg-(--tone) transition-opacity duration-300 ease-[steps(3,end)] motion-reduce:transition-none"
            style={{ opacity: Math.max(0, Math.min(1, pct / 100)).toFixed(2) }}
          />
        </span>
      ))}
    </span>
  );
}

/** A label and its figure on one line of a block. */
export function Row({ label, value }: { label: ReactNode; value: ReactNode }) {
  return (
    <span className="flex items-baseline justify-between gap-2.5 text-xs text-muted-foreground">
      <span className="truncate">{label}</span>
      <span className="num whitespace-nowrap text-foreground">{value ?? '—'}</span>
    </span>
  );
}
