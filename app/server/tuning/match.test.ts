import { assert, describe, it } from '@effect/vitest';
import type { GpuSample } from '@llama-webui/shared';
import { Array as Arr, Option, Record as Rec } from 'effect';
import { fakeModel, hw3 } from '../testing/tuning.ts';
import { estimate } from './estimate.ts';
import { matchGpus, retainedBusIds, withLiveMemory } from './match.ts';

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
const gpus = (o: { cuda0Used?: number; cuda0Proc?: number } = {}): Array<GpuSample> => [
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

const busIds = (m: Map<string, GpuSample>) => Rec.fromEntries(Arr.map([...m], ([id, g]) => [id, g.busId] as const));

describe('matchGpus', () => {
  it('pairs NVIDIA cards by name and AMD cards by VRAM size, the Vulkan copies included (#26)', () => {
    assert.deepStrictEqual(busIds(matchGpus(hw3().devices, gpus())), {
      CUDA0: '0000:01:00.0',
      CUDA1: '0000:02:00.0',
      Vulkan1: '0000:01:00.0',
      Vulkan2: '0000:02:00.0',
      Vulkan3: '0000:08:00.0',
    });
  });

  it('leaves out a hidden card', () => {
    const [a, b, c] = gpus();
    const m = matchGpus(hw3().devices, [{ ...(a as GpuSample), hidden: true }, b as GpuSample, c as GpuSample]);
    assert.isFalse(m.has('CUDA0'));
    assert.strictEqual(m.get('CUDA1')?.busId, '0000:02:00.0');
  });
});

describe('withLiveMemory', () => {
  it('VRAM used by another process shrinks the budget, the managed server’s own does not (#26)', () => {
    // 8.7 GiB dense model: fits on one 16 GiB card, not next to 8 GiB of another process.
    const model = fakeModel({ layers: 36, otherBytesPerLayer: 250 * MiB });
    const run = (g: Array<GpuSample>) =>
      estimate({ model, hw: { ...hw3(), devices: withLiveMemory(hw3().devices, g) }, preset: 'chat', mmprojBytes: 0 });

    assert.deepStrictEqual(run(gpus()).params.dev, ['CUDA0']);
    // 8 GiB taken on CUDA0 by something else: the model moves off it.
    const busy = withLiveMemory(hw3().devices, gpus({ cuda0Used: 8 * GiB }));
    const cuda0 = Arr.findFirst(busy, (d) => d.id === 'CUDA0');
    assert.isAbove(Option.getOrThrow(cuda0).otherUsedMib ?? 0, 7000);
    assert.notInclude(run(gpus({ cuda0Used: 8 * GiB })).params.dev ?? [], 'CUDA0');
    // The same 8 GiB held by our own llama-server: given back, CUDA0 is chosen again.
    assert.deepStrictEqual(run(gpus({ cuda0Used: 8 * GiB, cuda0Proc: 8 * GiB - 300 * MiB })).params.dev, ['CUDA0']);
  });

  it('a device the monitor does not know keeps the list values (#26)', () => {
    assert.deepStrictEqual(withLiveMemory(hw3().devices, []), hw3().devices);
  });

  it('a suspended card keeps the list values', () => {
    const [a, b, c] = gpus({ cuda0Used: 8 * GiB });
    const devices = withLiveMemory(hw3().devices, [
      { ...(a as GpuSample), suspended: true },
      b as GpuSample,
      c as GpuSample,
    ]);
    assert.deepStrictEqual(devices[0], hw3().devices[0]);
    assert.notDeepEqual(devices[1], hw3().devices[1]);
  });
});

describe('retainedBusIds', () => {
  it('without a device list, every monitored card is retained', () => {
    assert.deepStrictEqual(retainedBusIds({ devices: [], gpus: gpus(), dev: ['CUDA0'] }), [
      '0000:01:00.0',
      '0000:02:00.0',
      '0000:08:00.0',
    ]);
  });

  it('a card behind both a CUDA device and its Vulkan copy counts once, -dev none counts none', () => {
    assert.deepStrictEqual(
      retainedBusIds({ devices: hw3().devices, gpus: gpus(), dev: ['CUDA0', 'Vulkan1', 'none'] }),
      ['0000:01:00.0'],
    );
  });
});
