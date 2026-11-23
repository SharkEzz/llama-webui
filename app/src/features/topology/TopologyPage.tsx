import { phaseOf } from '@llama-webui/shared';
import { useEffect, useMemo } from 'react';
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
import { Hud, Legend } from './Hud';
import { useReducedMotion } from './useReducedMotion';
import { type TopologyView, useView } from './viewPrefs';

const VIEWS: readonly { view: TopologyView; label: string }[] = [
  { view: 'cards', label: 'Cards' },
  { view: 'board', label: 'Board' },
];

/**
 * The machine drawn in 2D, in one of two views, with the view control, the server phase and the model split. The
 * page is as tall as chat and logs (p-4 + status bar + gap): the drawing takes it, with the side column at its right,
 * and zooms and moves in its frame (see `Stage`). Only a page under 60 rem, too narrow for the column, puts the
 * column after the drawing and scrolls to it. The details of a block open beside it, in a popover.
 */
export function TopologyPage() {
  const graph = useTopology((s) => s.graph);
  const placement = useTopology((s) => s.placement);
  const error = useTopology((s) => s.error);
  const snapshot = useMonitor((s) => s.snapshot);
  const state = useServer((s) => s.view?.state);
  const reducedMotion = useReducedMotion();
  const [view, setView] = useView();

  // The graph is read while the page is shown, and again on each reconnect: the links' current state (Gen/width)
  // changes with power states. No other page asks for it.
  useEffect(() => watchTopology(), []);

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
  const View = view === 'board' ? BoardView : CardsView;

  return (
    <div className="@container">
      <div className="grid grid-cols-[minmax(0,1fr)] grid-rows-[2.5rem_calc(100dvh-5.5rem-3.25rem)_auto] gap-3 @[60rem]:h-[calc(100dvh-5.5rem)] @[60rem]:grid-cols-[minmax(0,1fr)_20rem] @[60rem]:grid-rows-[2.5rem_minmax(0,1fr)] @[60rem]:gap-x-4">
        <header className="flex items-center justify-between gap-3 @[60rem]:col-start-2 @[60rem]:row-start-1">
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

        <div className="min-h-0 @[60rem]:col-start-1 @[60rem]:row-span-2 @[60rem]:row-start-1">
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

        <div className="grid min-h-0 items-start gap-3 @2xl:grid-cols-2 @[60rem]:col-start-2 @[60rem]:row-start-2 @[60rem]:-m-1 @[60rem]:flex @[60rem]:flex-col @[60rem]:items-stretch @[60rem]:overflow-y-auto @[60rem]:p-1">
          <Hud phase={phase} snapshot={snapshot} graph={graph} placement={placement} tones={tones} error={error} />
          <Legend snapshot={snapshot} graph={graph} tones={tones} view={view} reducedMotion={reducedMotion} />
        </div>
      </div>
      <DetailPopover graph={graph} live={live} tones={tones} />
    </div>
  );
}
