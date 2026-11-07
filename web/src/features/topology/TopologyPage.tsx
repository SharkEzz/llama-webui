import { phaseOf } from '@llama-webui/shared';
import { LocateFixed } from 'lucide-react';
import { Component, type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { GLASS } from '@/components/glass/glass';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useMonitor } from '@/lib/monitor';
import { useServer } from '@/lib/server';
import { refreshTopology, useTopology } from '@/lib/topology';
import { cn } from '@/lib/utils';
import { gpuTones, linkFlows, nodeLive } from './flows';
import { Hud } from './Hud';
import { Labels } from './Labels';
import { layoutGraph } from './layout';
import { type SceneView, TopologyScene } from './TopologyScene';
import { useSceneColors } from './themeColors';
import { useReducedMotion } from './useReducedMotion';

/** Scène 3D plein cadre (hauteur du chat et des logs : p-4 + barre d'état + gap) et cartes HUD par-dessus. */
export function TopologyPage() {
  const graph = useTopology((s) => s.graph);
  const placement = useTopology((s) => s.placement);
  const error = useTopology((s) => s.error);
  const snapshot = useMonitor((s) => s.snapshot);
  const state = useServer((s) => s.view?.state);
  const colors = useSceneColors();
  const reducedMotion = useReducedMotion();
  const [hovered, setHovered] = useState<string | null>(null);
  const labelLayer = useRef<HTMLDivElement | null>(null);
  const view = useRef<SceneView | null>(null);
  const [viewMoved, setViewMoved] = useState(false);

  // Le graphe est relu à l'ouverture : l'état courant des liens (Gen/largeur) bouge avec les états d'énergie.
  useEffect(() => {
    void refreshTopology();
  }, []);

  const layout = useMemo(() => (graph ? layoutGraph(graph) : null), [graph]);
  const flows = useMemo(() => (graph ? linkFlows(graph, snapshot) : null), [graph, snapshot]);
  const live = useMemo(
    () => (graph && flows ? nodeLive(graph, snapshot, placement, flows) : null),
    [graph, snapshot, placement, flows],
  );
  const tones = useMemo(() => (graph ? gpuTones(graph) : new Map()), [graph]);
  const phase = phaseOf(state, snapshot);

  return (
    <div className={cn(GLASS, 'relative h-[calc(100dvh-5.5rem)] overflow-hidden')}>
      {graph && layout && flows && live ? (
        <SceneBoundary>
          <TopologyScene
            graph={graph}
            layout={layout}
            flows={flows}
            live={live}
            tones={tones}
            colors={colors}
            reducedMotion={reducedMotion}
            hovered={hovered}
            onHover={setHovered}
            labelLayer={labelLayer}
            view={view}
            onViewMoved={setViewMoved}
          />
        </SceneBoundary>
      ) : (
        <Skeleton className="absolute inset-4 rounded-md" />
      )}
      {graph && live && <Labels graph={graph} live={live} hovered={hovered} layerRef={labelLayer} />}
      <Hud
        phase={phase}
        snapshot={snapshot}
        graph={graph}
        placement={placement}
        flows={flows}
        tones={tones}
        reducedMotion={reducedMotion}
        error={error}
      />
      {graph && layout && (
        <div className="pointer-events-none absolute inset-x-0 bottom-3 z-20 flex flex-col items-center gap-1.5">
          <Button
            variant="secondary"
            size="sm"
            className={cn(GLASS, 'pointer-events-auto')}
            disabled={!viewMoved}
            onClick={() => view.current?.reset()}
          >
            <LocateFixed aria-hidden="true" />
            Recentrer la vue
          </Button>
          <p className="text-[11px] text-muted-foreground">
            Glisser : pivoter · Clic droit : déplacer · Molette : zoom
          </p>
        </div>
      )}
    </div>
  );
}

/** WebGL indisponible (pilote, navigateur distant sans accélération) : la page reste lisible, les cartes HUD aussi. */
class SceneBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <p className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
        Scène 3D indisponible : WebGL n'a pas pu démarrer dans ce navigateur.
      </p>
    );
  }
}
