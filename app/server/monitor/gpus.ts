import type { GpuReading, GpuSample } from '@llama-webui/shared';
import { Array as Arr, Effect, Order } from 'effect';
import type { AmdCard } from '../collectors/amdgpu.ts';
import { hiddenAmdReading, suspendedAmdReading } from '../collectors/amdgpu.ts';
import type { Collectors } from '../collectors/Collectors.ts';
import { gpuNeeds, gpuSkipped, identityReading } from '../collectors/gpu.ts';

const byBusId = Order.mapInput(Order.String, (g: GpuSample) => g.busId);

/**
 * Every card, sorted by bus id, with llama-server's VRAM on it when `pid` is one. A hidden card (`hiddenGpus`) is listed
 * by its identity only, whatever its reader gave; a sleeping AMD card is not read (a read would wake it up). The DRM
 * nodes of either are skipped when `/proc/<pid>/fdinfo` is read. A card whose read dies is left out.
 */
export const collectGpus = Effect.fn('Monitor.collectGpus')(function* (options: {
  readonly collectors: Collectors['Service'];
  readonly pid: number | null;
  readonly hiddenGpus: ReadonlyArray<string>;
}) {
  const { nvidia, amd } = options.collectors;
  const { pid } = options;
  const needs = gpuNeeds(options.hiddenGpus);
  const skipNodes = new Set<string>();
  const skip = (card: AmdCard, reading: GpuReading) => {
    for (const node of card.nodes ?? []) skipNodes.add(node);
    return reading;
  };
  const readAmd = (card: AmdCard) =>
    gpuSkipped(needs, card.pdev)
      ? Effect.succeed([skip(card, hiddenAmdReading(card))])
      : amd.suspended(card).pipe(
          Effect.flatMap((asleep) => (asleep ? Effect.succeed(skip(card, suspendedAmdReading(card))) : amd.read(card))),
          Effect.map(Arr.of),
          Effect.catchDefect(() => Effect.succeed(Arr.empty<GpuReading>())),
        );
  const [amdReadings, nvidiaReadings, nvidiaProc] = yield* Effect.all(
    [
      Effect.forEach(amd.cards, readAmd, { concurrency: 'unbounded' }).pipe(Effect.map(Arr.flatten)),
      nvidia.gpus,
      pid === null ? Effect.succeed(new Map<string, number>()) : nvidia.procVram(pid),
    ],
    { concurrency: 'unbounded' },
  );
  // After the AMD reads: they named the nodes to skip.
  const amdProc = pid === null ? new Map<string, number>() : yield* amd.procVram(pid, skipNodes);
  const sample =
    (proc: ReadonlyMap<string, number>) =>
    (g: GpuReading): GpuSample => {
      if (gpuSkipped(needs, g.busId)) return { ...identityReading(g, 'hidden'), procVramBytes: 0 };
      if (g.suspended === true || g.hidden === true) return { ...g, procVramBytes: 0 };
      return { ...g, procVramBytes: proc.get(g.key) ?? 0 };
    };
  return Arr.sort([...Arr.map(nvidiaReadings, sample(nvidiaProc)), ...Arr.map(amdReadings, sample(amdProc))], byBusId);
});
