import { Hono } from 'hono';
import { readPciTopology } from '../hardware/pci';
import type { Env } from '../http';
import type { PlacementTracker } from '../monitor/placement';

export interface TopologyRouteDeps {
  placement: PlacementTracker;
}

/** Hardware graph (re-read on every call: the current link state changes with power states) and model placement. */
export const topologyRoutes = ({ placement }: TopologyRouteDeps) =>
  new Hono<Env>().get('/api/topology', async (c) =>
    c.json({ graph: await readPciTopology(), placement: placement.current }),
  );
