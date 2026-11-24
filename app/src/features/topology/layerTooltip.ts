import { Tooltip } from '@base-ui/react/tooltip';
import type { LayerSegmentKind } from './flows';

/**
 * Ties every segment of a GPU VRAM bar to a single tooltip: hovering another segment moves it there, and zooming,
 * dragging or switching views closes it cleanly. Its payload is `encodeLayerTarget(nodeId, kind)`.
 */
export const layerTooltip = Tooltip.createHandle<string>();

const SEP = '\0';
const KINDS: readonly LayerSegmentKind[] = ['model', 'kv', 'compute', 'other', 'used', 'free'];

const isLayerSegmentKind = (value: string): value is LayerSegmentKind => KINDS.some((k) => k === value);

export const encodeLayerTarget = (nodeId: string, kind: LayerSegmentKind): string => `${nodeId}${SEP}${kind}`;

export function decodeLayerTarget(payload: string): { nodeId: string; kind: LayerSegmentKind } | null {
  const at = payload.lastIndexOf(SEP);
  if (at <= 0) return null;
  const kind = payload.slice(at + 1);
  if (!isLayerSegmentKind(kind)) return null;
  return { nodeId: payload.slice(0, at), kind };
}
