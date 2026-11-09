import { expect, test } from 'bun:test';
import type { GpuSample } from '@llama-webui/shared';
import { estimate } from './estimate';
import { fakeModel, hw3 } from './fixtures';
import { matchGpus, withLiveMemory } from './match';

const MiB = 1024 ** 2;
const GiB = 1024 ** 3;

const sample = (o: Partial<GpuSample> & Pick<GpuSample, 'key' | 'vendor' | 'name' | 'busId'>): GpuSample => ({
  utilPct: 0,
  vramUsedBytes: 300 * MiB,
  vramTotalBytes: 16 * GiB,
  tempC: null,
  powerW: null,
  procVramBytes: 0,
  ...o,
});

/** The monitor's view of the hw3 machine: NVML names, the pci.ids name of the RX 9070 XT, its VRAM total. */
const gpus = (o: { cuda0Used?: number; cuda0Proc?: number } = {}): GpuSample[] => [
  sample({
    key: 'nvidia:a',
    vendor: 'nvidia',
    name: 'NVIDIA GeForce RTX 5070 Ti',
    busId: '0000:01:00.0',
    vramTotalBytes: 16303 * MiB,
    vramUsedBytes: o.cuda0Used ?? 300 * MiB,
    procVramBytes: o.cuda0Proc ?? 0,
  }),
  sample({ key: 'nvidia:b', vendor: 'nvidia', name: 'NVIDIA GeForce RTX 5060 Ti', busId: '0000:02:00.0' }),
  sample({
    key: 'amd:0000:08:00.0',
    vendor: 'amd',
    name: 'Navi 48 [Radeon RX 9070/9070 XT/9070 GRE]',
    busId: '0000:08:00.0',
    vramTotalBytes: 16304 * MiB,
  }),
];

test('matchGpus pairs NVIDIA cards by name and AMD cards by VRAM size, the Vulkan copies included (#26)', () => {
  const m = matchGpus(hw3().devices, gpus());
  expect(Object.fromEntries([...m].map(([id, g]) => [id, g.busId]))).toEqual({
    CUDA0: '0000:01:00.0',
    CUDA1: '0000:02:00.0',
    Vulkan1: '0000:01:00.0',
    Vulkan2: '0000:02:00.0',
    Vulkan3: '0000:08:00.0',
  });
});

test('VRAM used by another process shrinks the budget, the managed server’s own does not (#26)', () => {
  // 8.7 GiB dense model: fits on one 16 GiB card, not next to 8 GiB of another process.
  const model = fakeModel({ layers: 36, otherBytesPerLayer: 250 * MiB });
  const run = (g: GpuSample[]) =>
    estimate({ model, hw: { ...hw3(), devices: withLiveMemory(hw3().devices, g) }, preset: 'chat', mmprojBytes: 0 });

  expect(run(gpus()).params.dev).toEqual(['CUDA0']);
  // 8 GiB taken on CUDA0 by something else: the model moves off it.
  const busy = withLiveMemory(hw3().devices, gpus({ cuda0Used: 8 * GiB }));
  expect(busy.find((d) => d.id === 'CUDA0')?.otherUsedMib).toBeGreaterThan(7000);
  expect(run(gpus({ cuda0Used: 8 * GiB })).params.dev).not.toContain('CUDA0');
  // The same 8 GiB held by our own llama-server: given back, CUDA0 is chosen again.
  expect(run(gpus({ cuda0Used: 8 * GiB, cuda0Proc: 8 * GiB - 300 * MiB })).params.dev).toEqual(['CUDA0']);
});

test('a device the monitor does not know keeps the list values (#26)', () => {
  const devices = withLiveMemory(hw3().devices, []);
  expect(devices).toEqual(hw3().devices);
});
