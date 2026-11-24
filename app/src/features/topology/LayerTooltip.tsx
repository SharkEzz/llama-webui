import { Tooltip as TooltipPrimitive } from '@base-ui/react/tooltip';
import type { TopologyGraph } from '@llama-webui/shared';
import { useEffect } from 'react';
import type { Tone } from '@/components/glass/tones';
import { TooltipContent } from '@/components/ui/tooltip';
import { formatBytes, formatPct } from '@/lib/format';
import { cn } from '@/lib/utils';
import { layerSwatchColor, toneOfNode } from './constants';
import { layerSlice, type NodeLive } from './flows';
import { decodeLayerTarget, layerTooltip } from './layerTooltip';

interface LayerTooltipProps {
  graph: TopologyGraph | null;
  live: Map<string, NodeLive> | null;
  tones: Map<string, Tone>;
}

/** Single tooltip shared by every segment of every GPU VRAM bar, following live updates while hovered. */
export function LayerTooltip(props: LayerTooltipProps) {
  return (
    <TooltipPrimitive.Root handle={layerTooltip} trackCursorAxis="x">
      {({ payload }) => <LayerTooltipBody target={payload ?? null} {...props} />}
    </TooltipPrimitive.Root>
  );
}

function LayerTooltipBody({ target, graph, live, tones }: LayerTooltipProps & { target: string | null }) {
  const parsed = target ? decodeLayerTarget(target) : null;
  const node = parsed && graph ? graph.nodes.find((n) => n.id === parsed.nodeId) : undefined;
  const figures = parsed && live ? live.get(parsed.nodeId) : undefined;
  const slice = parsed ? layerSlice(figures, parsed.kind) : null;
  const gone = target !== null && (!node || !slice);

  useEffect(() => {
    if (gone) layerTooltip.close();
  }, [gone]);

  if (!node || !slice) return null;

  const color = slice.kind === 'free' ? null : layerSwatchColor(slice.kind, toneOfNode(node, tones), true);
  return (
    <TooltipContent side="top" sideOffset={6} className="whitespace-nowrap">
      <span
        aria-hidden="true"
        className={cn(
          'size-2 shrink-0 rounded-full',
          color === null ? 'bg-background/15 ring-1 ring-background/50 ring-inset' : 'ring-1 ring-background/20',
        )}
        style={color === null ? undefined : { background: color }}
      />
      <span className="font-medium">{slice.label}</span>
      <span className="num opacity-85">
        {formatBytes(slice.bytes)}
        {slice.announcedBytes !== undefined && ` of ${formatBytes(slice.announcedBytes)}`} ({formatPct(slice.pct)})
      </span>
    </TooltipContent>
  );
}
