import { readPciTopology } from '../hardware/pci';
import { guarded } from '../http';
import type { PlacementTracker } from '../monitor/placement';

export interface TopologyRouteDeps {
  placement: PlacementTracker;
}

/** Hardware graph (re-read on every call: the current link state changes with power states) and model placement. */
export function topologyRoutes({ placement }: TopologyRouteDeps) {
  return {
    '/api/topology': {
      GET: guarded(async () => Response.json({ graph: await readPciTopology(), placement: placement.current })),
    },
  };
}
