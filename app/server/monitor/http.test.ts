import { assert, layer } from '@effect/vitest';
import { Api } from '@llama-webui/shared';
import { Array as Arr, Effect, Layer, Option } from 'effect';
import { HttpServer } from 'effect/http';
import { HttpApiTest } from 'effect/http-api';
import { AppInfo } from '../config/AppInfo.ts';
import { CpuInfo } from '../hardware/CpuInfo.ts';
import { ServicesTest } from '../testing/services.ts';
import { MonitorHandlers } from './http.ts';

const makeClient = HttpApiTest.groups(Api, ['monitor']);

/** The handlers on the services of the app (the stub monitor), for the typed client. */
const Handlers = Layer.mergeAll(MonitorHandlers.pipe(Layer.provideMerge(ServicesTest)), HttpServer.layerServices);

layer(Handlers)('MonitorApi', (it) => {
  it.effect("history answers the stub's dump and this boot's id", () =>
    Effect.gen(function* () {
      const client = yield* makeClient;
      const { bootId } = yield* AppInfo;
      const history = yield* client.monitor.history();
      assert.deepStrictEqual(history, { intervalMs: 1000, capacity: 0, at: 0, times: [], series: {}, bootId });
    }),
  );

  it.effect('snapshot answers null before any tick', () =>
    Effect.gen(function* () {
      const client = yield* makeClient;
      const snapshot = yield* client.monitor.snapshot();
      assert.isNull(snapshot);
    }),
  );

  it.effect('system info lists the CPU, no GPU before a snapshot, and nvml with the stub', () =>
    Effect.gen(function* () {
      const client = yield* makeClient;
      const info = yield* client.monitor.systemInfo();
      assert.isAtLeast(info.cpu.physicalCores, 1);
      assert.isAtLeast(info.cpu.logicalThreads, info.cpu.physicalCores);
      assert.isAtLeast(info.cpu.numaNodes, 1);
      assert.deepStrictEqual(info.gpus, []);
      assert.strictEqual(info.nvidiaSource, 'nvml');
    }),
  );

  it.effect('topology answers a graph with the CPU and RAM and no placement', () =>
    Effect.gen(function* () {
      const client = yield* makeClient;
      const { graph, placement } = yield* client.monitor.topology();
      const ids = Arr.map(graph.nodes, (node) => node.id);
      assert.includeMembers([...ids], ['cpu', 'ram']);
      assert.isTrue(Arr.some(graph.links, (link) => link.id === 'cpu-ram'));
      assert.isNull(placement);
    }),
  );
});

/** The CPU the server keeps: the topology's CPU node must be this one, not a new read of `/proc/cpuinfo`. */
const KEPT_CPU = { model: 'Kept CPU', physicalCores: 3, logicalThreads: 5, numaNodes: 1, flags: [] };

const WithKeptCpu = Layer.mergeAll(
  MonitorHandlers.pipe(
    Layer.provide(Layer.succeed(CpuInfo, CpuInfo.of({ read: Effect.succeed(KEPT_CPU) }))),
    Layer.provideMerge(ServicesTest),
  ),
  HttpServer.layerServices,
);

layer(WithKeptCpu)('MonitorApi with the CPU kept', (it) => {
  it.effect("topology's CPU node is the CPU the server keeps", () =>
    Effect.gen(function* () {
      const client = yield* makeClient;
      const { graph } = yield* client.monitor.topology();
      const cpu = Arr.findFirst(graph.nodes, (node) => node.id === 'cpu').pipe(Option.getOrUndefined);
      assert.deepStrictEqual(cpu?.detail, { model: 'Kept CPU', physicalCores: 3, logicalThreads: 5, numaNodes: 1 });
    }),
  );
});
