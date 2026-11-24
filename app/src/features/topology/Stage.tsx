import { pcieBps, type TopologyGraph, type TopologyLink, type TopologyNode } from '@llama-webui/shared';
import { Maximize, ZoomIn, ZoomOut } from 'lucide-react';
import {
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
} from 'react';
import { GLASS } from '@/components/glass/glass';
import { TONE_VAR, type Tone } from '@/components/glass/tones';
import { Button } from '@/components/ui/button';
import { useTheme } from '@/lib/theme';
import { cn } from '@/lib/utils';
import { type Camera, fitCamera, panBy, resolveCamera, reveal, ZOOM_MAX, ZOOM_STEP, zoomAt } from './camera';
import { detailPopover } from './detailPopover';
import { type Level, type LinkFlow, linkBadge, type NodeLive, type PeerLink } from './flows';
import { layerTooltip } from './layerTooltip';
import { createStreakLoop, laneStates, type StreakLoop, trackLook } from './streaks';
import { resolveColor } from './themeColors';
import type { ViewLayout } from './tree';

/*
 * The frame both views draw in: the drawing at its natural size, whole in the room it has until someone zooms or
 * moves it (the wheel, a drag, the three buttons), with the tracks of the links (SVG), their labels (text) and their
 * streaks (one canvas). The blocks are the view's own.
 */

/** What the page hands a view. */
export interface ViewProps {
  graph: TopologyGraph;
  live: Map<string, NodeLive>;
  flows: Map<string, LinkFlow>;
  /** Current state of each PCIe link (“Gen4 x8”), by link id. */
  specs: Map<string, string>;
  peers: readonly PeerLink[];
  tones: Map<string, Tone>;
  /** llama-server is loading, processing a prompt or generating: every link with traffic shows it. */
  busy: boolean;
  reducedMotion: boolean;
}

export interface StageProps extends Pick<ViewProps, 'graph' | 'flows' | 'specs' | 'tones' | 'busy' | 'reducedMotion'> {
  layout: ViewLayout;
  /** Drawn under everything else (the board's outline). */
  backdrop?: ReactNode;
  /** The blocks, each at its rectangle of the layout. */
  children: ReactNode;
}

/** Widest PCIe link there is: the thickest track. */
const WIDEST_BPS = pcieBps(5, 16) ?? 1;
/** Canvas pixels per px of the drawing, at most: a large drawing on a dense screen stays a reasonable canvas. */
const MAX_RATIO = 2;
/** How far the pointer goes, in px, before a press on the drawing is a drag and no longer a click. */
const DRAG_START = 4;
/** Scale change per px of wheel: a notch of a mouse wheel (100 px) is about 16%; a pinch of a touchpad counts more. */
const WHEEL_RATE = 0.0015;
const PINCH_RATE = 0.01;
/** Height of a line, in px, for a wheel that counts in lines. */
const WHEEL_LINE = 16;

const LEVEL_COLOR: Record<Exclude<Level, 'ok'>, string> = { warn: 'var(--warning)', crit: 'var(--destructive)' };
const LEVEL_TEXT: Record<Level, string> = {
  ok: 'text-muted-foreground',
  warn: 'text-warning',
  crit: 'text-destructive',
};

const CHIP =
  'pointer-events-none absolute -translate-x-1/2 -translate-y-1/2 rounded-lg border border-surface-border bg-popover px-1.5 py-0.5 text-[11px] leading-snug whitespace-nowrap text-muted-foreground';

function trackWidth(link: TopologyLink, flow: LinkFlow | undefined): number {
  if (link.kind === 'memory') return 9;
  if (link.kind === 'internal') return 2;
  return 3 + 6.5 * Math.sqrt(Math.max(0, flow?.maxBps ?? 0) / WIDEST_BPS);
}

/** A link's own color: the tone of the GPU it reaches, indigo for the memory, teal for the rest. */
function toneOfLink(link: TopologyLink, to: TopologyNode | undefined, tones: Map<string, Tone>): string {
  if (link.kind === 'memory') return 'var(--tone-indigo)';
  const tone = to?.kind === 'gpu' ? tones.get(to.id) : undefined;
  return tone ? TONE_VAR[tone] : 'var(--tone-teal)';
}

export function Stage({ graph, layout, flows, specs, tones, busy, reducedMotion, backdrop, children }: StageProps) {
  const frame = useRef<HTMLDivElement | null>(null);
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const loop = useRef<StreakLoop | null>(null);
  const [room, setRoom] = useState<{ w: number; h: number } | null>(null);
  const theme = useTheme((s) => s.resolved);

  useEffect(() => {
    const el = frame.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect;
      if (box) setRoom({ w: box.width, h: box.height });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // What someone zoomed or moved to; null shows the whole drawing, whatever the size of the frame
  const [chosen, setChosen] = useState<Camera | null>(null);
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ id: number; x: number; y: number; moved: boolean } | null>(null);
  const dragged = useRef(false);

  const natural = useMemo(() => ({ w: layout.width, h: layout.height }), [layout.width, layout.height]);
  const camera = resolveCamera(chosen, room ?? { w: 0, h: 0 }, natural);
  const fit = fitCamera(room ?? { w: 0, h: 0 }, natural);
  const { scale } = camera;
  // A step of a quarter: the canvas is not allocated again at each notch of the wheel
  const ratio = Math.min(
    MAX_RATIO,
    Math.ceil(scale * (typeof devicePixelRatio === 'number' ? devicePixelRatio : 1) * 4) / 4,
  );

  /** Zooms around a point of the frame, its center by default. */
  const zoom = (factor: number, at?: { x: number; y: number }) => {
    if (!room) return;
    // The details and tooltips stand beside a block that is about to move
    detailPopover.close();
    layerTooltip.close();
    const next = zoomAt(camera, factor, at ?? { x: room.w / 2, y: room.h / 2 }, room, natural);
    setChosen(next.scale <= fit.scale ? null : next);
  };
  const onWheel = useEffectEvent((event: WheelEvent) => {
    const el = frame.current;
    if (!el) return;
    // The wheel zooms here: it does not scroll the page under the drawing
    event.preventDefault();
    const box = el.getBoundingClientRect();
    const delta = event.deltaY * (event.deltaMode === WheelEvent.DOM_DELTA_LINE ? WHEEL_LINE : 1);
    zoom(Math.exp(-delta * (event.ctrlKey ? PINCH_RATE : WHEEL_RATE)), {
      x: event.clientX - box.left,
      y: event.clientY - box.top,
    });
  });
  // React's wheel listener is passive: it cannot keep the page from scrolling
  useEffect(() => {
    const el = frame.current;
    if (!el) return;
    const listener = (event: WheelEvent) => onWheel(event);
    el.addEventListener('wheel', listener, { passive: false });
    return () => el.removeEventListener('wheel', listener);
  }, []);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, moved: false };
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.id !== event.pointerId || !room) return;
    const dx = event.clientX - d.x;
    const dy = event.clientY - d.y;
    if (!d.moved) {
      if (Math.hypot(dx, dy) < DRAG_START) return;
      d.moved = true;
      // From here the press is a drag: the frame keeps the pointer, and the block under it gets no click
      event.currentTarget.setPointerCapture(event.pointerId);
      detailPopover.close();
      layerTooltip.close();
      setDragging(true);
    }
    d.x = event.clientX;
    d.y = event.clientY;
    setChosen(panBy(camera, dx, dy, room, natural));
  };
  const onPointerEnd = (event: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.id !== event.pointerId) return;
    drag.current = null;
    if (!d.moved) return;
    setDragging(false);
    // The click that follows a drag is not one: it is dropped, and so is the mark if no click comes
    dragged.current = true;
    setTimeout(() => {
      dragged.current = false;
    }, 0);
  };

  const links = useMemo(() => {
    const nodes = new Map(graph.nodes.map((n) => [n.id, n]));
    const byId = new Map(graph.links.map((l) => [l.id, l]));
    return layout.links.flatMap((geo) => {
      const link = byId.get(geo.id);
      if (!link) return [];
      const to = nodes.get(link.to);
      return [{ geo, link, to, tone: toneOfLink(link, to, tones) }];
    });
  }, [graph, layout, tones]);
  const states = useMemo(
    () => laneStates(graph.links, flows, busy, reducedMotion),
    [graph, flows, busy, reducedMotion],
  );

  // The streak loop lives as long as the canvas; it only runs a timer while a link has streaks
  useEffect(() => {
    if (!canvas.current) return;
    const created = createStreakLoop(canvas.current);
    loop.current = created;
    return () => {
      created.stop();
      loop.current = null;
    };
  }, []);
  useEffect(() => {
    loop.current?.resize(layout.width, layout.height, ratio);
  }, [layout.width, layout.height, ratio]);
  useEffect(() => {
    loop.current?.setLinks(layout.links);
  }, [layout]);
  useEffect(() => {
    const toneOf = new Map(links.map((l) => [l.geo.id, l.tone]));
    loop.current?.setStates(states, (id, level) =>
      resolveColor(level === 'ok' ? (toneOf.get(id) ?? 'var(--tone-teal)') : LEVEL_COLOR[level], theme),
    );
  }, [states, links, theme]);

  return (
    <div className="relative size-full">
      <div
        ref={frame}
        className={cn(
          'relative size-full touch-none overflow-clip select-none',
          dragging ? 'cursor-grabbing' : 'cursor-grab',
        )}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
        onClickCapture={(event) => {
          if (!dragged.current) return;
          dragged.current = false;
          event.preventDefault();
          event.stopPropagation();
        }}
        onFocus={(event) => {
          // A block reached with the keyboard comes into view; one clicked is already under the pointer
          const el = frame.current;
          if (!el || !room || !event.target.matches(':focus-visible')) return;
          const box = el.getBoundingClientRect();
          const block = event.target.getBoundingClientRect();
          const rect = { x: block.left - box.left, y: block.top - box.top, w: block.width, h: block.height };
          const next = reveal(camera, rect, room, natural);
          if (next !== camera) setChosen(next);
        }}
      >
        <div
          className={cn('absolute top-0 left-0 origin-top-left', room === null && 'invisible')}
          style={{
            width: layout.width,
            height: layout.height,
            transform: `translate(${Math.round(camera.x)}px, ${Math.round(camera.y)}px) scale(${scale})`,
          }}
        >
          {backdrop}
          <svg
            aria-hidden="true"
            width={layout.width}
            height={layout.height}
            className="absolute inset-0 overflow-visible"
            fill="none"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            {links.map(({ geo, link, tone }) => {
              const flow = flows.get(link.id);
              const { share, dashed } = trackLook(link, flow, busy, reducedMotion);
              const color = flow && flow.level !== 'ok' ? LEVEL_COLOR[flow.level] : tone;
              return (
                <path
                  key={geo.id}
                  d={geo.route.d}
                  strokeWidth={trackWidth(link, flow).toFixed(1)}
                  strokeDasharray={dashed ? '10 8' : undefined}
                  stroke={
                    share === null
                      ? 'color-mix(in oklch, var(--foreground) 13%, transparent)'
                      : `color-mix(in oklch, ${color} ${share}%, transparent)`
                  }
                  className="transition-[stroke] duration-300 ease-[steps(3,end)] motion-reduce:transition-none"
                />
              );
            })}
            {layout.peers.map((peer) => (
              <path
                key={peer.id}
                d={peer.route.d}
                stroke="var(--muted-foreground)"
                strokeWidth={1.5}
                strokeDasharray="2 7"
                opacity={peer.confirmed ? 0.85 : 0.5}
              />
            ))}
          </svg>
          {children}
          {/* Above the blocks, which it never covers: a block's glass does not blur again at each frame */}
          <canvas
            ref={canvas}
            aria-hidden="true"
            className="pointer-events-none absolute inset-0"
            style={{ width: layout.width, height: layout.height }}
          />
          {links.map(({ geo, link, to }) => {
            if (!geo.badge || !to) return null;
            const flow = flows.get(link.id);
            const spec = specs.get(link.id);
            const badge = flow ? linkBadge(link, to, flow, busy) : null;
            if (!spec && !badge) return null;
            return (
              <div key={geo.id} className={CHIP} style={{ left: geo.badge.x, top: geo.badge.y }}>
                <span className="sr-only">{link.kind === 'memory' ? 'Memory link' : `Link of ${to.label}`}: </span>
                {spec && <span className="block text-center num text-faint-foreground">{spec}</span>}
                {badge && (
                  <span className="grid grid-cols-[auto_auto] gap-x-2">
                    {badge.lines.map((line) => (
                      <span key={line.label} className="contents">
                        <span>{line.label}</span>
                        <span className="text-right num text-foreground">{line.value}</span>
                      </span>
                    ))}
                  </span>
                )}
                {badge?.pct && (
                  <span className={cn('block text-center num font-medium', LEVEL_TEXT[badge.level])}>
                    {badge.pct} of capacity
                  </span>
                )}
              </div>
            );
          })}
          {layout.peers.map((peer) => (
            <span
              key={peer.id}
              className={cn(CHIP, 'font-medium', peer.confirmed && 'text-foreground')}
              style={{ left: peer.tag.x, top: peer.tag.y }}
            >
              {peer.confirmed ? 'P2P' : 'P2P requested'}
            </span>
          ))}
        </div>
      </div>
      <div role="group" aria-label="Zoom" className="absolute right-3 bottom-3 flex flex-col gap-1">
        <Button
          variant="secondary"
          size="icon-sm"
          className={GLASS}
          aria-label="Zoom in"
          title="Zoom in"
          disabled={scale >= ZOOM_MAX}
          onClick={() => zoom(ZOOM_STEP)}
        >
          <ZoomIn aria-hidden="true" />
        </Button>
        <Button
          variant="secondary"
          size="icon-sm"
          className={GLASS}
          aria-label="Reset zoom"
          title="Reset zoom"
          disabled={chosen === null}
          onClick={() => {
            detailPopover.close();
            layerTooltip.close();
            setChosen(null);
          }}
        >
          <Maximize aria-hidden="true" />
        </Button>
        <Button
          variant="secondary"
          size="icon-sm"
          className={GLASS}
          aria-label="Zoom out"
          title="Zoom out"
          disabled={scale <= fit.scale}
          onClick={() => zoom(1 / ZOOM_STEP)}
        >
          <ZoomOut aria-hidden="true" />
        </Button>
      </div>
    </div>
  );
}
