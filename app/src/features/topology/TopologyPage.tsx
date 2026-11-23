import { phaseOf } from '@llama-webui/shared';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Tone } from '@/components/glass/tones';
import { Skeleton } from '@/components/ui/skeleton';
import { useMonitor } from '@/lib/monitor';
import { useServer } from '@/lib/server';
import { useTopology, watchTopology } from '@/lib/topology';
import { cn } from '@/lib/utils';
import { BoardView } from './BoardView';
import { CardsView } from './CardsView';
import { DetailPopover } from './Detail';
import { detailPopover } from './detailPopover';
import { gpuTones, linkFlows, linkSpecs, nodeLive, peerLinks } from './flows';
import { columnAtRight } from './geometry';
import { Hud } from './Hud';
import { layoutBoard } from './layoutBoard';
import { layoutCards } from './layoutCards';
import { useReducedMotion } from './useReducedMotion';
import { type TopologyView, useView } from './viewPrefs';

const VIEWS: readonly { view: TopologyView; label: string }[] = [
  { view: 'cards', label: 'Cards' },
  { view: 'board', label: 'Board' },
];

/**
 * The machine drawn in 2D, in one of two views, with the view control, the server phase and the model split. The
 * first screen of the page is as tall as chat and logs (p-4 + status bar + gap) and the drawing takes all of it: the
 * side column stands at its right only when that does not shrink it (see `columnAtRight`), and comes after it
 * otherwise, the page scrolling to it. The details of a block open beside it, in a popover.
 */
export function TopologyPage() {
  const graph = useTopology((s) => s.graph);
  const placement = useTopology((s) => s.placement);
  const error = useTopology((s) => s.error);
  const snapshot = useMonitor((s) => s.snapshot);
  const state = useServer((s) => s.view?.state);
  const reducedMotion = useReducedMotion();
  const [view, setView] = useView();
  const screen = useRef<HTMLDivElement | null>(null);
  const [page, setPage] = useState({ w: 0, h: 0 });

  // The graph is read while the page is shown, and again on each reconnect: the links' current state (Gen/width)
  // changes with power states. No other page asks for it.
  useEffect(() => watchTopology(), []);

  useEffect(() => {
    const el = screen.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect;
      if (box) setPage({ w: box.width, h: box.height });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const flows = useMemo(() => (graph ? linkFlows(graph, snapshot) : null), [graph, snapshot]);
  const live = useMemo(
    () => (graph && flows ? nodeLive(graph, snapshot, placement, flows) : null),
    [graph, snapshot, placement, flows],
  );
  const specs = useMemo(() => (graph ? linkSpecs(graph, snapshot) : new Map<string, string>()), [graph, snapshot]);
  const tones = useMemo(() => (graph ? gpuTones(graph) : new Map<string, Tone>()), [graph]);
  const peers = useMemo(() => (graph ? peerLinks(graph, placement) : []), [graph, placement]);
  const phase = phaseOf(state, snapshot);
  const busy = phase === 'loading' || phase === 'prompt' || phase === 'generating';

  // Where the column goes depends on the size of the drawing, which its view decides
  const wide = useMemo(() => {
    if (!graph) return false;
    const { width, height } = view === 'board' ? layoutBoard(graph, peers) : layoutCards(graph, peers);
    return columnAtRight(page, { w: width, h: height });
  }, [graph, peers, view, page]);
  const View = view === 'board' ? BoardView : CardsView;

  return (
    <div className="@container relative">
      {/* The first screen of the page, whatever its content: what the drawing and the column have to share */}
      <div
        ref={screen}
        aria-hidden="true"
        className="pointer-events-none invisible absolute inset-x-0 top-0 h-[calc(100dvh-5.5rem)]"
      />
      <div
        className={cn(
          'grid gap-3',
          wide
            ? 'h-[calc(100dvh-5.5rem)] grid-cols-[minmax(0,1fr)_20rem] grid-rows-[2.5rem_minmax(0,1fr)] gap-x-4'
            : 'grid-cols-[minmax(0,1fr)] grid-rows-[2.5rem_calc(100dvh-5.5rem-3.25rem)_auto]',
        )}
      >
        <header className={cn('flex items-center justify-between gap-3', wide && 'col-start-2 row-start-1')}>
          <h1 className="text-base font-semibold tracking-tight">Topology</h1>
          <div
            role="group"
            aria-label="View"
            className="inline-flex gap-0.5 rounded-lg bg-well p-0.5 inset-shadow-well"
          >
            {VIEWS.map((v) => (
              <button
                key={v.view}
                type="button"
                aria-pressed={view === v.view}
                onClick={() => {
                  // The details belong to a block of the view that leaves
                  detailPopover.close();
                  setView(v.view);
                }}
                className={cn(
                  'rounded-md px-2.5 py-1 text-xs font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  view === v.view
                    ? 'bg-card text-foreground shadow-surface ring-1 ring-surface-border'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {v.label}
              </button>
            ))}
          </div>
        </header>

        <div className={cn('min-h-0', wide && 'col-start-1 row-span-2 row-start-1')}>
          {graph && live && flows ? (
            <View
              graph={graph}
              live={live}
              flows={flows}
              specs={specs}
              peers={peers}
              tones={tones}
              busy={busy}
              reducedMotion={reducedMotion}
            />
          ) : (
            <Skeleton className="size-full rounded-md" />
          )}
        </div>

        <div
          className={cn(
            'min-h-0 gap-3',
            wide
              ? 'col-start-2 row-start-2 -m-1 flex flex-col overflow-y-auto p-1'
              : 'grid items-start @2xl:grid-cols-2 @5xl:grid-cols-3',
          )}
        >
          <Hud
            phase={phase}
            snapshot={snapshot}
            graph={graph}
            placement={placement}
            tones={tones}
            view={view}
            reducedMotion={reducedMotion}
            error={error}
          />
        </div>
      </div>
      <DetailPopover graph={graph} live={live} tones={tones} />
    </div>
  );
}
