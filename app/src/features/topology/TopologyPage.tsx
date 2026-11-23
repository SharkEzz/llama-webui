import { phaseOf } from '@llama-webui/shared';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Tone } from '@/components/glass/tones';
import { Skeleton } from '@/components/ui/skeleton';
import { useMonitor } from '@/lib/monitor';
import { useServer } from '@/lib/server';
import { useTopology, watchTopology } from '@/lib/topology';
import { cn } from '@/lib/utils';
import { toneOfNode } from './blocks';
import { BoardView } from './BoardView';
import { CardsView } from './CardsView';
import { Detail } from './Detail';
import { detailOf, gpuTones, linkFlows, linkSpecs, nodeLive, peerLinks } from './flows';
import { Hud } from './Hud';
import { useReducedMotion } from './useReducedMotion';
import { type TopologyView, useView } from './viewPrefs';

const VIEWS: readonly { view: TopologyView; label: string }[] = [
  { view: 'cards', label: 'Cards' },
  { view: 'board', label: 'Board' },
];

/** The block whose details are open: the only pressed one of the drawing. */
const selectedBlock = () => document.querySelector<HTMLElement>('[data-node][aria-pressed="true"]');

/**
 * The machine drawn in 2D, in one of two views, with a side column: the view control, the details of the selected
 * block, the server phase and the model split. The column stands at the right of the drawing once the page is wide
 * enough for both (80 rem, sidebar aside), at the height of chat and logs (p-4 + status bar + gap); below, one column
 * that scrolls with the page, the details right under the drawing.
 */
export function TopologyPage() {
  const graph = useTopology((s) => s.graph);
  const placement = useTopology((s) => s.placement);
  const error = useTopology((s) => s.error);
  const snapshot = useMonitor((s) => s.snapshot);
  const state = useServer((s) => s.view?.state);
  const reducedMotion = useReducedMotion();
  const [view, setView] = useView();
  const [selected, setSelected] = useState<string | null>(null);
  const panel = useRef<HTMLDivElement | null>(null);

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

  // A block that left the graph has no details any more: the panel closes with it
  const detail = graph && live ? detailOf(graph, live, selected) : null;
  const openId = detail?.node.id ?? null;
  const View = view === 'board' ? BoardView : CardsView;

  useEffect(() => {
    if (openId === null) return;
    // In one column the panel sits under the drawing: bring it into view
    const details = panel.current;
    details?.scrollIntoView({ block: 'nearest' });
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      // The focus leaves with the panel it was in: it goes back to the block the panel was opened from
      if (details?.contains(document.activeElement)) selectedBlock()?.focus();
      setSelected(null);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [openId]);

  const close = () => {
    // The close button leaves with its panel: the focus goes back to the block it was opened from
    selectedBlock()?.focus();
    setSelected(null);
  };

  return (
    <div className="@container">
      <div className="grid grid-cols-[minmax(0,1fr)] gap-3 @7xl:h-[calc(100dvh-5.5rem)] @7xl:grid-cols-[minmax(0,1fr)_20rem] @7xl:grid-rows-[auto_minmax(0,1fr)]">
        <header className="flex items-center justify-between gap-3 @7xl:col-start-2 @7xl:row-start-1">
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
                onClick={() => setView(v.view)}
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

        <div className="h-[72dvh] min-h-0 @7xl:col-start-1 @7xl:row-span-2 @7xl:row-start-1 @7xl:h-auto">
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
              selected={openId}
              onSelect={(id) => setSelected((current) => (current === id ? null : id))}
            />
          ) : (
            <Skeleton className="size-full rounded-md" />
          )}
        </div>

        <div className="grid min-h-0 items-start gap-3 @2xl:grid-cols-2 @5xl:grid-cols-3 @7xl:col-start-2 @7xl:row-start-2 @7xl:-m-1 @7xl:flex @7xl:flex-col @7xl:items-stretch @7xl:overflow-y-auto @7xl:p-1">
          {detail && (
            <div ref={panel}>
              <Detail detail={detail} tone={toneOfNode(detail.node, tones)} onClose={close} />
            </div>
          )}
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
    </div>
  );
}
