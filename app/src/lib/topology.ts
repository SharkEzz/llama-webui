import type { ModelPlacement, TopologyGraph } from '@llama-webui/shared';
import { create } from 'zustand';
import { call } from './api';
import { onWs, useWs } from './ws';

interface TopologyState {
  /** Hardware graph (sysfs); null until it has been read. */
  graph: TopologyGraph | null;
  /** Placement of the loaded model; null without a managed server or until the logs have provided it. */
  placement: ModelPlacement | null;
  /** The last read of /api/topology failed. */
  error: boolean;
}

export const useTopology = create<TopologyState>()(() => ({ graph: null, placement: null, error: false }));

/** Sequence number of the last placement received over WS: a REST response sent before it must not overwrite it. */
let placementSeq = 0;
let requestSeq = 0;

/** Rereads the graph (current link state changes with power states) and the placement. */
export async function refreshTopology(): Promise<void> {
  const req = ++requestSeq;
  const seenPlacement = placementSeq;
  try {
    const r = await call((api) => api.monitor.topology());
    if (req !== requestSeq) return; // a newer reread is in flight: it wins
    useTopology.setState(
      placementSeq === seenPlacement
        ? { graph: r.graph, placement: r.placement, error: false }
        : { graph: r.graph, error: false },
    );
  } catch {
    if (req === requestSeq) useTopology.setState({ error: true });
  }
}

let started = false;
/** Feeds the store: “placement” messages + a reread on every (re)connect. */
export function startTopologySync(): void {
  if (started) return;
  started = true;
  onWs('placement', (m) => {
    placementSeq++;
    useTopology.setState({ placement: m.payload });
  });
  useWs.subscribe((s, prev) => {
    if (s.status === 'open' && prev.status !== 'open') void refreshTopology();
  });
}
