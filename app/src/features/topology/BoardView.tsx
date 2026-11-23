import type { TopologyNode } from '@llama-webui/shared';
import { useId, useMemo } from 'react';
import { plural } from '@/lib/format';
import { cn } from '@/lib/utils';
import { Block, factOf, FillPct, Layers, Threads, toneOfNode } from './blocks';
import type { NodeLive } from './flows';
import type { Rect } from './geometry';
import { type BoardLayout, layoutBoard } from './layoutBoard';
import { Stage, type ViewProps } from './Stage';

/*
 * The machine as the plan of a motherboard, seen from above: the socket, the memory modules at its right, a slot per
 * GPU, the chipset and the drives. A convention: the app knows what hangs off what, not where a slot is on this
 * board (see layoutBoard).
 */

const NAME = 'truncate text-[12.5px] font-semibold tracking-tight';
const SUB = 'text-[11.5px] whitespace-nowrap text-muted-foreground';
const FIGURE = 'num text-foreground';
/** A part the size of a drive or less: one line. */
const STICK_MAX_H = 40;

export function BoardView({ graph, live, peers, tones, ...stage }: ViewProps) {
  const layout = useMemo(() => layoutBoard(graph, peers), [graph, peers]);
  const pattern = useId();
  return (
    <Stage
      graph={graph}
      layout={layout}
      tones={tones}
      {...stage}
      backdrop={<Backdrop layout={layout} pattern={pattern} />}
    >
      {graph.nodes.map((node) => {
        const rect = layout.rects.get(node.id);
        const l = live.get(node.id);
        if (!rect || !l) return null;
        const block = { node, live: l, rect, tone: toneOfNode(node, tones) };
        if (node.kind === 'ram')
          return (
            <Block key={node.id} {...block} bare>
              <Memory live={l} rect={rect} layout={layout} />
            </Block>
          );
        if (node.kind === 'cpu')
          return (
            <Block
              key={node.id}
              {...block}
              className="flex flex-col items-center justify-between gap-1.5 rounded-xl p-[11px] text-center"
            >
              <Socket node={node} live={l} />
            </Block>
          );
        if (node.kind === 'chipset')
          return (
            <Block
              key={node.id}
              {...block}
              className="flex flex-col items-center justify-center gap-0.5 rounded-[9px] px-2 text-center"
            >
              <span className="line-clamp-2 text-[12.5px] leading-tight font-semibold tracking-tight">
                {node.label}
              </span>
              <Devices live={l} />
            </Block>
          );
        if (rect.h <= STICK_MAX_H)
          return (
            <Block key={node.id} {...block} className="flex items-center gap-[9px] rounded-[7px] px-[11px]">
              <Stick node={node} live={l} />
            </Block>
          );
        return (
          <Block key={node.id} {...block} className="flex flex-col justify-between rounded-[9px] px-3 pt-[9px] pb-2.5">
            <Slot node={node} live={l} />
            {node.kind === 'gpu' && (
              // The edge connector of a card in its slot
              <span
                aria-hidden="true"
                className="absolute right-[120px] -bottom-1.5 left-[26px] h-1.5 rounded-b-[3px] opacity-50"
                style={{
                  background: 'repeating-linear-gradient(to right, var(--tone-amber) 0 3px, transparent 3px 6px)',
                }}
              />
            )}
          </Block>
        );
      })}
    </Stage>
  );
}

/** The board itself: its outline on a faint grid, its mounting holes, the socket's frame. Decoration only. */
function Backdrop({ layout, pattern }: { layout: BoardLayout; pattern: string }) {
  const { board, socket } = layout;
  const holes = [
    [board.x + 22, board.y + 22],
    [board.x + board.w - 22, board.y + 22],
    [board.x + 22, board.y + board.h - 22],
    [board.x + board.w - 22, board.y + board.h - 22],
  ] as const;
  const faint = 'color-mix(in oklch, var(--foreground) 12%, transparent)';
  return (
    <svg
      aria-hidden="true"
      width={layout.width}
      height={layout.height}
      className="absolute inset-0 overflow-visible"
      fill="none"
    >
      <defs>
        <pattern id={pattern} width="16" height="16" patternUnits="userSpaceOnUse">
          <path d="M16 0H0V16" stroke="color-mix(in oklch, var(--foreground) 5%, transparent)" />
        </pattern>
      </defs>
      <rect
        x={board.x}
        y={board.y}
        width={board.w}
        height={board.h}
        rx="16"
        fill="color-mix(in oklch, var(--foreground) 3%, transparent)"
        stroke="var(--surface-border-bright)"
      />
      <rect x={board.x} y={board.y} width={board.w} height={board.h} rx="16" fill={`url(#${pattern})`} />
      {holes.map(([cx, cy]) => (
        <circle key={`${cx}:${cy}`} cx={cx} cy={cy} r="5" stroke={faint} />
      ))}
      <rect
        x={socket.x - 14}
        y={socket.y - 14}
        width={socket.w + 28}
        height={socket.h + 28}
        rx="16"
        stroke={faint}
        strokeDasharray="3 5"
      />
    </svg>
  );
}

function Socket({ node, live }: { node: TopologyNode; live: NodeLive }) {
  const threads = live.cores.length || Number(node.detail.logicalThreads) || 0;
  const columns = threads <= 16 ? 4 : threads <= 32 ? 8 : 16;
  const rows = Math.ceil(threads / columns);
  // Tiles of the mockup's size while they fit, smaller ones for a CPU with many threads
  const tile = {
    w: columns === 4 ? 28 : columns === 8 ? 15 : 7,
    h: Math.min(22, Math.floor(92 / Math.max(1, rows)) - 3),
  };
  return (
    <>
      <span className={cn(NAME, 'max-w-full')}>{node.label}</span>
      {threads > 0 && (
        <span
          className="block"
          style={{ width: columns * tile.w + (columns - 1) * 3, height: rows * tile.h + (rows - 1) * 3 }}
        >
          <Threads cores={live.cores} count={threads} columns={columns} className="size-full" />
        </span>
      )}
      <span className="flex items-baseline gap-1.5">
        <span className="num text-[22px] leading-none font-semibold tracking-tight">{live.headline}</span>
        <span className={cn(SUB, FIGURE)}>{factOf(live, 'Temperature') ?? ''}</span>
      </span>
    </>
  );
}

/** The memory: its figures, then its modules, each one a tank at the level of the whole (the app reads one pool). */
function Memory({ live, rect, layout }: { live: NodeLive; rect: Rect; layout: BoardLayout }) {
  return (
    <>
      <span className="absolute inset-x-0 top-0 flex items-baseline justify-between gap-2">
        <span className={NAME}>Memory</span>
        <FillPct live={live} className="text-[12.5px] font-medium" />
      </span>
      <span className={cn(SUB, FIGURE, 'absolute inset-x-0 top-[18px] truncate')}>{live.headline}</span>
      {layout.dimms.map((dimm) => {
        const style = {
          left: dimm.rect.x - rect.x,
          top: dimm.rect.y - rect.y,
          width: dimm.rect.w,
          height: dimm.rect.h,
        };
        return dimm.filled ? (
          <span
            key={dimm.rect.x}
            className="absolute rounded-md bg-card p-[3px] shadow-surface ring-1 ring-surface-border"
            style={style}
          >
            <Layers live={live} vertical className="size-full rounded-sm" />
          </span>
        ) : (
          <span
            key={dimm.rect.x}
            aria-hidden="true"
            className="absolute rounded-md border border-dashed border-foreground/15"
            style={style}
          />
        );
      })}
    </>
  );
}

/** A card in a slot: its name and figures on two lines over the bar of its memory. */
function Slot({ node, live }: { node: TopologyNode; live: NodeLive }) {
  if (live.dim || node.kind !== 'gpu')
    return (
      <span className="flex items-baseline gap-3">
        <span className={NAME}>{node.label}</span>
        <span className={cn(SUB, 'ml-auto')}>{factOf(live, 'State') ?? live.headline ?? ''}</span>
      </span>
    );
  return (
    <>
      <span className="flex items-baseline gap-3">
        <span className="flex min-w-0 items-center gap-[7px]">
          <span aria-hidden="true" className="size-2 shrink-0 rounded-xs bg-(--tone)" />
          <span className={NAME}>{node.label}</span>
        </span>
        <span className={cn(SUB, FIGURE, 'ml-auto')}>{factOf(live, 'Temperature') ?? '—'}</span>
        <span className={cn(SUB, FIGURE)}>{factOf(live, 'Power') ?? '—'}</span>
      </span>
      <span className="flex items-baseline gap-3">
        <span className={SUB}>
          Utilization <span className={FIGURE}>{live.headline}</span>
        </span>
        <span className={cn(SUB, 'ml-auto')}>
          VRAM <FillPct live={live} className="text-foreground" />
        </span>
        <span className={cn(SUB, FIGURE)}>{live.sub ?? '—'}</span>
      </span>
      <Layers live={live} neutral className="h-3.5 rounded-[5px]" />
    </>
  );
}

/** A drive, or a GPU inside the CPU: one line. A drive's light follows its activity. */
function Stick({ node, live }: { node: TopologyNode; live: NodeLive }) {
  const active = Math.max(0, Math.min(1, (live.loadPct ?? 0) / 100));
  return (
    <>
      <span
        aria-hidden="true"
        className={cn('size-1.5 shrink-0 rounded-full', node.kind === 'gpu' ? 'bg-(--tone)' : 'bg-success')}
        style={node.kind === 'gpu' ? undefined : { opacity: 0.25 + 0.75 * Math.sqrt(active) }}
      />
      <span className={NAME}>{node.label}</span>
      {node.kind === 'gpu' && <span className={cn(SUB, FIGURE, 'ml-auto')}>{live.headline}</span>}
    </>
  );
}

function Devices({ live }: { live: NodeLive }) {
  const count = Number(factOf(live, 'Devices'));
  if (!Number.isFinite(count)) return null;
  return (
    <span className={SUB}>
      <span className={FIGURE}>{count}</span> {plural(count, 'device')}
    </span>
  );
}
