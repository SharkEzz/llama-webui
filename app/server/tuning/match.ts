import { type BenchDevice, baseName, type GpuSample, gpuDevices, MiB } from '@llama-webui/shared';
import { Array as Arr, Option, Order } from 'effect';
import { dual } from 'effect/Function';

const vendorOf = (d: BenchDevice): Option.Option<GpuSample['vendor']> => {
  if (d.backend === 'CUDA') return Option.some('nvidia');
  if (d.backend === 'ROCm' || d.backend === 'HIP') return Option.some('amd');
  if (/NVIDIA/i.test(d.name)) return Option.some('nvidia');
  if (/\bAMD\b|Radeon/i.test(d.name)) return Option.some('amd');
  return Option.none();
};

const byBusId = Order.mapInput(Order.String, (g: GpuSample) => g.busId);

/**
 * The monitored card behind each `--list-devices` device (by id), when it can be told. `--list-devices` has no PCI
 * address: NVIDIA cards are matched by name (CUDA and NVML use the same one), AMD cards by memory size (the pci.ids
 * name differs from the driver's, the VRAM total is the same). Identical cards are taken in bus order. Hidden cards
 * (not read) are left out; an unmatched device (iGPU, unknown vendor) is absent from the map.
 */
export const matchGpus: {
  (gpus: ReadonlyArray<GpuSample>): (devices: ReadonlyArray<BenchDevice>) => Map<string, GpuSample>;
  (devices: ReadonlyArray<BenchDevice>, gpus: ReadonlyArray<GpuSample>): Map<string, GpuSample>;
} = dual(2, (devices: ReadonlyArray<BenchDevice>, gpus: ReadonlyArray<GpuSample>): Map<string, GpuSample> => {
  const out = new Map<string, GpuSample>();
  const sorted = Arr.sort(
    Arr.filter(gpus, (g) => g.hidden !== true),
    byBusId,
  );
  // One card per device of a backend; the same card may back a CUDA device and its Vulkan copy.
  const taken = new Map<string, Set<string>>();
  for (const d of devices) {
    const vendor = vendorOf(d);
    if (Option.isNone(vendor) || d.totalMib <= 0) continue;
    const used = taken.get(d.backend) ?? new Set<string>();
    taken.set(d.backend, used);
    const name = baseName(d.name);
    const g = Arr.findFirst(
      sorted,
      (gpu) =>
        gpu.vendor === vendor.value &&
        !used.has(gpu.key) &&
        (vendor.value === 'nvidia'
          ? gpu.name === name
          : Math.abs(gpu.vramTotalBytes / MiB - d.totalMib) <= 0.02 * d.totalMib),
    );
    if (Option.isNone(g)) continue;
    used.add(g.value.key);
    out.set(d.id, g.value);
  }
  return out;
});

/** What `retainedBusIds` reads: the device list, the monitored cards and the estimate's `-dev`. */
export interface RetainedOptions {
  readonly devices: ReadonlyArray<BenchDevice>;
  readonly gpus: ReadonlyArray<GpuSample>;
  readonly dev: ReadonlyArray<string> | undefined;
}

/**
 * Bus ids of the cards llama-server will run on: the estimate's `-dev` (all dedicated cards when it has none), matched
 * to the monitored cards. Without a device list, every monitored card counts (nothing better to go on).
 */
export const retainedBusIds = ({ devices, gpus, dev }: RetainedOptions): Array<string> => {
  if (!Arr.isReadonlyArrayNonEmpty(devices)) return Arr.map(gpus, (g) => g.busId);
  const ids = dev === undefined ? Arr.map(gpuDevices(devices), (d) => d.id) : Arr.filter(dev, (id) => id !== 'none');
  const matched = matchGpus(devices, gpus);
  return Arr.dedupe(
    Arr.flatMap(ids, (id) =>
      Option.match(Option.fromNullishOr(matched.get(id)), { onNone: () => [], onSome: (g) => [g.busId] }),
    ),
  );
};

/**
 * The devices with their live memory: `freeMib` from the monitor (the list's is a snapshot of its first read) and
 * `otherUsedMib`, the VRAM used by other processes than the managed llama-server (whose own share is given back to
 * the estimator: it would be freed by a restart). Unmatched devices keep the list's values.
 */
export const withLiveMemory: {
  (gpus: ReadonlyArray<GpuSample>): (devices: ReadonlyArray<BenchDevice>) => Array<BenchDevice>;
  (devices: ReadonlyArray<BenchDevice>, gpus: ReadonlyArray<GpuSample>): Array<BenchDevice>;
} = dual(2, (devices: ReadonlyArray<BenchDevice>, gpus: ReadonlyArray<GpuSample>): Array<BenchDevice> => {
  const matched = matchGpus(devices, gpus);
  return Arr.map(devices, (d) => {
    const g = matched.get(d.id);
    if (g === undefined || g.suspended === true || g.vramTotalBytes <= 0) return d;
    const liveFreeMib = (g.vramTotalBytes - g.vramUsedBytes) / MiB;
    return {
      ...d,
      freeMib: Math.round(Math.max(0, Math.min(d.totalMib, liveFreeMib))),
      otherUsedMib: Math.round(Math.max(0, d.totalMib - liveFreeMib - g.procVramBytes / MiB)),
    };
  });
});
