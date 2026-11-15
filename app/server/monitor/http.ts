import { Api } from '@llama-webui/shared';
import { Array as Arr, Effect, type FileSystem, type Path } from 'effect';
import { HttpApiBuilder } from 'effect/http-api';
import { AppInfo } from '../config/AppInfo.ts';
import { readCpuInfo } from '../hardware/cpu.ts';
import type { PciIds } from '../hardware/PciIds.ts';
import { readPciTopology } from '../hardware/pci.ts';
import { Monitor } from './Monitor.ts';
import { Placement } from './Placement.ts';

/** The monitoring's endpoints: the history, the last snapshot, the machine and its topology. */
export const MonitorHandlers = HttpApiBuilder.group(
  Api,
  'monitor',
  Effect.fn(function* (handlers) {
    const monitor = yield* Monitor;
    const placement = yield* Placement;
    const { bootId } = yield* AppInfo;
    // Taken when the routes are built: a handler then needs nothing from the request.
    const services = yield* Effect.context<FileSystem.FileSystem | Path.Path | PciIds>();
    // The CPU does not change while the process runs: read on the first call, then replayed.
    const cpu = yield* Effect.cached(readCpuInfo().pipe(Effect.provideContext(services)));

    /** The CPU, the identity of each card the last snapshot saw (none before it), and the NVIDIA source. */
    const systemInfo = Effect.gen(function* () {
      const latest = yield* monitor.latest;
      const gpus = Arr.map(latest?.allGpus ?? [], ({ key, name, vendor, busId, vramTotalBytes }) => ({
        key,
        name,
        vendor,
        busId,
        vramTotalBytes,
      }));
      // Once the collectors are up: the source is chosen when they start.
      const nvidiaSource = yield* monitor.nvidiaSource;
      return { cpu: yield* cpu, gpus, nvidiaSource };
    }).pipe(Effect.withSpan('MonitorHandlers.systemInfo'));

    /** The hardware graph, read again on every call (the link state changes with power states), and the placement. */
    const topology = Effect.gen(function* () {
      const graph = yield* readPciTopology().pipe(Effect.provideContext(services));
      return { graph, placement: yield* placement.current };
    }).pipe(Effect.withSpan('MonitorHandlers.topology'));

    return handlers
      .handle('history', () => Effect.map(monitor.history, (dump) => ({ ...dump, bootId })))
      .handle('snapshot', () => monitor.latest)
      .handle('systemInfo', () => systemInfo)
      .handle('topology', () => topology);
  }),
);
