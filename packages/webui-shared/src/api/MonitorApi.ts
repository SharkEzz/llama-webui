import { Schema } from 'effect';
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from 'effect/http-api';
import { HistoryDump, Snapshot, SystemInfo } from '../monitor.ts';
import { ModelPlacement, TopologyGraph } from '../topology.ts';

/** The history held by the monitor, and the start it belongs to (a new boot id: the client's copy is stale). */
export const HistoryReply = Schema.Struct({ ...HistoryDump.fields, bootId: Schema.String }).annotate({
  identifier: 'HistoryReply',
  description: 'In-memory monitoring history time series tagged with the current server bootId.',
});
export type HistoryReply = typeof HistoryReply.Type;

/** The hardware graph (read again on every call: the link state changes with power states) and the model placement. */
export const Topology = Schema.Struct({ graph: TopologyGraph, placement: Schema.NullOr(ModelPlacement) }).annotate({
  identifier: 'Topology',
  description: 'Live PCIe/memory hardware topology graph paired with the active model placement.',
});
export type Topology = typeof Topology.Type;

/** The monitoring: the history, the last snapshot (null before the first tick), the machine and its topology. */
export class MonitorApi extends HttpApiGroup.make('monitor')
  .add(
    HttpApiEndpoint.get('history', '/api/monitor/history', { success: HistoryReply }).annotateMerge(
      OpenApi.annotations({
        summary: 'Read monitoring history',
        description:
          'Returns all buffered time series (`SERIES` keys) from the in-memory ring buffer, oldest tick first, with `null` marking gaps.',
      }),
    ),
    HttpApiEndpoint.get('snapshot', '/api/monitor/snapshot', { success: Schema.NullOr(Snapshot) }).annotateMerge(
      OpenApi.annotations({
        summary: 'Get latest monitoring snapshot',
        description:
          'Returns the latest monitoring `Snapshot`, or `null` before the first tick (or under `LLAMA_WEBUI_TEST_MONITOR=stub`).',
      }),
    ),
    HttpApiEndpoint.get('systemInfo', '/api/system/info', { success: SystemInfo }).annotateMerge(
      OpenApi.annotations({
        summary: 'Get system hardware info',
        description:
          'Returns static CPU topology, all detected GPUs (hidden and sleeping included), and NVIDIA telemetry source.',
      }),
    ),
    HttpApiEndpoint.get('topology', '/api/topology', { success: Topology }).annotateMerge(
      OpenApi.annotations({
        summary: 'Get PCIe topology and placement',
        description:
          'Re-reads the sysfs PCIe/memory graph (capturing live link speeds) and returns it alongside the current model placement.',
      }),
    ),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: 'Monitor',
      description:
        'Hardware and `llama-server` telemetry snapshots, time-series history, static system info and PCIe topology.',
    }),
  ) {}
