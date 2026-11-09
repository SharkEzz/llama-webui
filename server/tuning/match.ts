import { type BenchDevice, type GpuSample, gpuDevices } from '@llama-webui/shared';

const MiB = 1024 ** 2;
/** Vulkan appends the driver to the name: “AMD Radeon RX 9070 XT (RADV GFX1201)”. */
const baseName = (name: string) => name.replace(/\s*\((RADV|AMDVLK|NVK|ANV)[^)]*\)\s*$/i, '').trim();

function vendorOf(d: BenchDevice): GpuSample['vendor'] | null {
  if (d.backend === 'CUDA') return 'nvidia';
  if (d.backend === 'ROCm' || d.backend === 'HIP') return 'amd';
  if (/NVIDIA/i.test(d.name)) return 'nvidia';
  if (/\bAMD\b|Radeon/i.test(d.name)) return 'amd';
  return null;
}

/**
 * The monitored card behind each `--list-devices` device (by id), when it can be told. `--list-devices` has no PCI
 * address: NVIDIA cards are matched by name (CUDA and NVML use the same one), AMD cards by memory size (the pci.ids
 * name differs from the driver's, the VRAM total is the same). Identical cards are taken in bus order. Hidden cards
 * (not read) are left out; an unmatched device (iGPU, unknown vendor) is absent from the map.
 */
export function matchGpus(devices: BenchDevice[], gpus: GpuSample[]): Map<string, GpuSample> {
  const out = new Map<string, GpuSample>();
  const sorted = gpus.filter((g) => !g.hidden).sort((a, b) => a.busId.localeCompare(b.busId));
  // One card per device of a backend; the same card may back a CUDA device and its Vulkan copy.
  const taken = new Map<string, Set<string>>();
  for (const d of devices) {
    const vendor = vendorOf(d);
    if (!vendor || d.totalMib <= 0) continue;
    const used = taken.get(d.backend) ?? new Set<string>();
    taken.set(d.backend, used);
    const name = baseName(d.name);
    const g = sorted.find(
      (g) =>
        g.vendor === vendor &&
        !used.has(g.key) &&
        (vendor === 'nvidia' ? g.name === name : Math.abs(g.vramTotalBytes / MiB - d.totalMib) <= 0.02 * d.totalMib),
    );
    if (!g) continue;
    used.add(g.key);
    out.set(d.id, g);
  }
  return out;
}

/**
 * Bus ids of the cards llama-server will run on: the estimate's `-dev` (all dedicated cards when it has none), matched
 * to the monitored cards. Without a device list, every monitored card counts (nothing better to go on).
 */
export function retainedBusIds(devices: BenchDevice[], gpus: GpuSample[], dev: string[] | undefined): string[] {
  if (devices.length === 0) return gpus.map((g) => g.busId);
  const ids = dev?.filter((id) => id !== 'none') ?? gpuDevices(devices).map((d) => d.id);
  const matched = matchGpus(devices, gpus);
  return [...new Set(ids.flatMap((id) => matched.get(id)?.busId ?? []))];
}

/**
 * The devices with their live memory: `freeMib` from the monitor (the list's is a snapshot of its first read) and
 * `otherUsedMib`, the VRAM used by other processes than the managed llama-server (whose own share is given back to
 * the estimator: it would be freed by a restart). Unmatched devices keep the list's values.
 */
export function withLiveMemory(devices: BenchDevice[], gpus: GpuSample[]): BenchDevice[] {
  const matched = matchGpus(devices, gpus);
  return devices.map((d) => {
    const g = matched.get(d.id);
    if (!g || g.suspended || g.vramTotalBytes <= 0) return d;
    const liveFreeMib = (g.vramTotalBytes - g.vramUsedBytes) / MiB;
    return {
      ...d,
      freeMib: Math.round(Math.max(0, Math.min(d.totalMib, liveFreeMib))),
      otherUsedMib: Math.round(Math.max(0, d.totalMib - liveFreeMib - g.procVramBytes / MiB)),
    };
  });
}
