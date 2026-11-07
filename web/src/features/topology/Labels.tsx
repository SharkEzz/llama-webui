import type { TopologyGraph } from '@llama-webui/shared';
import type { RefObject } from 'react';
import { cn } from '@/lib/utils';
import type { NodeLive } from './flows';

interface LabelsProps {
  graph: TopologyGraph;
  live: Map<string, NodeLive>;
  hovered: string | null;
  layerRef: RefObject<HTMLDivElement | null>;
}

/**
 * Étiquettes des blocs et infobulle du bloc survolé : DOM ordinaire (typographie et tokens du thème), ancré par la
 * scène sur le sommet de chaque bloc (voir <Projector>). Invisibles tant que la scène ne les a pas placées.
 */
export function Labels({ graph, live, hovered, layerRef }: LabelsProps) {
  return (
    <div ref={layerRef} className="pointer-events-none absolute inset-0 z-30 overflow-hidden">
      {graph.nodes.map((n) => {
        const l = live.get(n.id);
        if (!l) return null;
        const isHovered = hovered === n.id;
        return (
          <div
            key={n.id}
            data-node={n.id}
            className={cn('group invisible absolute top-0 left-0 will-change-transform', isHovered && 'z-10')}
          >
            <div
              className={cn(
                'flex -translate-x-1/2 -translate-y-full flex-col items-center whitespace-nowrap rounded-md bg-card/80 px-1.5 py-0.5 text-center ring-1 ring-surface-border backdrop-blur-sm',
                l.dim && 'opacity-60',
                isHovered && 'ring-primary/60',
              )}
            >
              <span className="max-w-32 truncate text-[11px] font-medium leading-tight text-foreground">{n.label}</span>
              <span className="num text-[11px] leading-tight text-muted-foreground">{l.headline}</span>
            </div>
            {isHovered && l.facts.length > 0 && (
              <dl className="absolute bottom-full left-1/2 mb-10 grid min-w-52 -translate-x-1/2 grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 rounded-lg bg-popover px-3 py-2 text-xs shadow-surface ring-1 ring-surface-border group-[.tip-below]:top-full group-[.tip-below]:bottom-auto group-[.tip-below]:mt-2 group-[.tip-below]:mb-0">
                <dt className="col-span-2 mb-0.5 font-medium text-foreground">{n.label}</dt>
                {l.facts.map((f) => (
                  <Row key={f.label} label={f.label} value={f.value} />
                ))}
              </dl>
            )}
          </div>
        );
      })}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt className="whitespace-nowrap text-muted-foreground">{label}</dt>
      <dd
        className={cn(
          'num text-right text-foreground',
          value.length > 28 ? 'max-w-56 whitespace-normal' : 'whitespace-nowrap',
        )}
      >
        {value}
      </dd>
    </>
  );
}
