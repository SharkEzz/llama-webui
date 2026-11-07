import { readPciTopology } from '../hardware/pci';
import { guarded } from '../http';
import type { PlacementTracker } from '../monitor/placement';

export interface TopologyRouteDeps {
  placement: PlacementTracker;
}

/** Graphe matériel (relu à chaque appel : l'état courant des liens change avec les états d'énergie) et placement du modèle. */
export function topologyRoutes({ placement }: TopologyRouteDeps) {
  return {
    '/api/topology': {
      GET: guarded(async () => Response.json({ graph: await readPciTopology(), placement: placement.current })),
    },
  };
}
