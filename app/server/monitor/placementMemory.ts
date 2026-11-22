import type { ModelPlacement, P2pStatus, PlacementBuffer, TopologyNode } from '@llama-webui/shared';
import { Array as Arr, Effect, FileSystem, Path, String as Str } from 'effect';
import type { ModelMemory, ModelMemoryDevice } from 'llamacpp-js/models';
import { readTrimmed } from '../collectors/read.ts';
import { finite } from './finite.ts';

/** Minimal PCI GPU identity read from sysfs for matching single-GPU SSE device names without logs. */
export interface SysfsGpu {
  readonly busId: string;
  readonly vendor: TopologyNode['vendor'];
}

const VENDORS: Readonly<Record<string, TopologyNode['vendor']>> = {
  '0x10de': 'nvidia',
  '0x1002': 'amd',
  '0x8086': 'intel',
};

/**
 * Reads GPU PCI busIds and vendors from sysfs (`/sys/bus/pci/devices`), without waking suspended cards. Returns empty
 * when sysfs is unavailable.
 */
export const readSysfsGpus = (
  sysfsRoot = '/sys/bus/pci/devices',
): Effect.Effect<ReadonlyArray<SysfsGpu>, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const entries = yield* fs.readDirectory(sysfsRoot).pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
    const out: Array<SysfsGpu> = [];
    for (const busId of entries) {
      const dir = path.join(sysfsRoot, busId);
      const cls = yield* readTrimmed(path.join(dir, 'class'));
      if (cls === null || !Str.startsWith('0x03')(Str.toLowerCase(cls))) continue;
      const rawVendor = yield* readTrimmed(path.join(dir, 'vendor'));
      const vendor = rawVendor === null ? 'other' : (VENDORS[Str.toLowerCase(rawVendor)] ?? 'other');
      out.push({ busId: Str.toLowerCase(busId), vendor });
    }
    return out;
  });

/** Vendor implied by a ggml device name (`CUDA0` → nvidia, `ROCm0`/`HIP0` → amd, `SYCL0` → intel), else undefined. */
const vendorOfDevice = (name: string): TopologyNode['vendor'] | undefined => {
  if (/^CUDA\d+$/i.test(name)) return 'nvidia';
  if (/^(?:ROCm|HIP)\d+$/i.test(name)) return 'amd';
  if (/^SYCL\d+$/i.test(name)) return 'intel';
  return undefined;
};

/**
 * Resolves a PCI busId for a GPU entry from `/models/sse`:
 * 1. Exact match from `busIds` (parsed from llama-server's own `using device` / NCCL logs when available).
 * 2. Unambiguous single-GPU match from `gpus` (index 0 when exactly one GPU of that vendor — or one GPU total for
 *    vendor-neutral backends like Vulkan — exists).
 * Otherwise `null` (never guesses across multiple GPUs).
 */
const resolveBusId = (
  device: ModelMemoryDevice,
  busIds: ReadonlyMap<string, string>,
  gpus: ReadonlyArray<SysfsGpu>,
): string | null => {
  if (device.kind === 'host') return null;
  const fromLogs = busIds.get(device.name);
  if (fromLogs !== undefined) return fromLogs;
  if (!Str.endsWith('0')(device.name)) return null;
  const vendor = vendorOfDevice(device.name);
  const candidates = vendor === undefined ? gpus : Arr.filter(gpus, (g) => g.vendor === vendor);
  return candidates.length === 1 ? (candidates[0]?.busId ?? null) : null;
};

/**
 * Builds a `ModelPlacement` from llama-server's `/models/sse` `data.memory` report (fallback when startup buffer logs
 * are missing, e.g. external server or `-lv < 4`). Returns `null` when no device holds any bytes.
 */
export const placementFromMemory = (options: {
  readonly memory: ModelMemory;
  readonly busIds?: ReadonlyMap<string, string>;
  readonly gpus?: ReadonlyArray<SysfsGpu>;
  readonly launchSeq?: number;
  readonly layers?: ModelPlacement['layers'];
  readonly p2p?: P2pStatus;
}): ModelPlacement | null => {
  const busIds = options.busIds ?? new Map<string, string>();
  const gpus = options.gpus ?? [];
  const buffers: Array<PlacementBuffer> = [];
  for (const d of options.memory.devices) {
    const modelBytes = Math.max(0, finite(d.model));
    const kvBytes = Math.max(0, finite(d.context));
    const computeBytes = Math.max(0, finite(d.compute));
    if (modelBytes + kvBytes + computeBytes <= 0) continue;
    buffers.push({
      device: d.name,
      busId: resolveBusId(d, busIds, gpus),
      modelBytes,
      kvBytes,
      computeBytes,
    });
  }
  if (buffers.length === 0) return null;
  return {
    launchSeq: options.launchSeq ?? 0,
    layers: options.layers ?? null,
    buffers,
    ...(options.p2p === undefined ? {} : { p2p: options.p2p }),
    source: 'sse',
  };
};
