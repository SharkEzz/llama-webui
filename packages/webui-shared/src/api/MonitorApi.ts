import { Schema } from 'effect';
import { HttpApiEndpoint, HttpApiGroup } from 'effect/http-api';
import { HistoryDump, Snapshot, SystemInfo } from '../monitor.ts';
import { ModelPlacement, TopologyGraph } from '../topology.ts';

/** The history held by the monitor, and the start it belongs to (a new boot id: the client's copy is stale). */
export const HistoryReply = Schema.Struct({ ...HistoryDump.fields, bootId: Schema.String });
export type HistoryReply = typeof HistoryReply.Type;

/** The hardware graph (read again on every call: the link state changes with power states) and the model placement. */
export const Topology = Schema.Struct({ graph: TopologyGraph, placement: Schema.NullOr(ModelPlacement) });
export type Topology = typeof Topology.Type;

/** The monitoring: the history, the last snapshot (null before the first tick), the machine and its topology. */
export class MonitorApi extends HttpApiGroup.make('monitor').add(
  HttpApiEndpoint.get('history', '/api/monitor/history', { success: HistoryReply }),
  HttpApiEndpoint.get('snapshot', '/api/monitor/snapshot', { success: Schema.NullOr(Snapshot) }),
  HttpApiEndpoint.get('systemInfo', '/api/system/info', { success: SystemInfo }),
  HttpApiEndpoint.get('topology', '/api/topology', { success: Topology }),
) {}
