import { expect, test } from 'bun:test';
import { deviceRole } from '@llama-webui/shared';
import { fakeModel, hw3 } from './fixtures';
import { fitOf, measurePlacement, type PlacementInput } from './placement';

const MiB = 1024 ** 2;
const GiB = 1024 ** 3;
const moe = fakeModel({ layers: 48, experts: 128, expertBytesPerLayer: 300 * MiB, otherBytesPerLayer: 30 * MiB });
const input = (o: Partial<PlacementInput>): PlacementInput => ({
  model: moe,
  devices: hw3().devices,
  params: {},
  ctx: 8192,
  kv: { k: 'f16', v: 'f16' },
  ub: 512,
  mmprojBytes: 0,
  ramAvailableBytes: 55 * GiB,
  ...o,
});

test('deviceRole skips the Vulkan copies of the CUDA cards and the iGPU', () => {
  const all = hw3().devices;
  expect(all.map((d) => deviceRole(d, all))).toEqual([
    'gpu',
    'gpu',
    'integrated',
    'duplicate',
    'duplicate',
    'gpu',
    'host',
  ]);
});

test('deviceRole treats the ROCm iGPU as integrated and the Vulkan copy of a ROCm card as a duplicate (#22)', () => {
  const dev = (id: string, name: string, totalMib: number) => ({
    id,
    name,
    totalMib,
    freeMib: totalMib,
    backend: id.replace(/\d+$/, ''),
  });
  // llama.cpp b12211 built with CUDA, HIP and Vulkan on the user's machine.
  const all = [
    dev('ZenDNN', 'ZenDNN: AMD optimized primitives backend for GGML (optimized for AMD CPUs)', 0),
    dev('CUDA0', 'NVIDIA GeForce RTX 5070 Ti', 15901),
    dev('CUDA1', 'NVIDIA GeForce RTX 5060 Ti', 15909),
    dev('ROCm0', 'AMD Radeon RX 9070 XT', 16304),
    dev('ROCm1', 'AMD Radeon Graphics', 31335),
    dev('Vulkan0', 'AMD Radeon RX 9070 XT (RADV GFX1201)', 16304),
    dev('Vulkan1', 'Radeon 8060S Graphics (RADV GFX1151)', 98304),
  ];
  expect(all.map((d) => deviceRole(d, all))).toEqual(['host', 'gpu', 'gpu', 'gpu', 'integrated', 'duplicate', 'gpu']);
});

test('-ncmoe moves the experts of the first N layers to RAM', () => {
  const m = measurePlacement(input({ params: { dev: ['CUDA0'], ngl: 'all', ncmoe: 8 } }));
  expect(m.cpuExpertsBytes).toBe(8 * 300 * MiB);
  expect(m.ram).toBe(8 * 300 * MiB + 300 * MiB); // experts + token_embd
  expect([...m.vram.keys()]).toEqual(['CUDA0']);
  const weightsOnGpu = 40 * 300 * MiB + 48 * 30 * MiB + 301 * MiB;
  expect(m.gpuWeights).toBe(weightsOnGpu);
  expect(m.vram.get('CUDA0')!).toBeGreaterThan(weightsOnGpu);
});

test('-ot wins over -ngl and -ts splits the layers in order', () => {
  const m = measurePlacement(
    input({ params: { dev: ['CUDA0', 'CUDA1'], ts: [3, 1], ngl: 'all', ot: ['ffn_.*_exps=CPU'] } }),
  );
  expect(m.cpuExpertsBytes).toBe(48 * 300 * MiB);
  expect(m.layerDevice.slice(0, 36).every((d) => d === 'CUDA0')).toBe(true);
  expect(m.layerDevice.slice(36).every((d) => d === 'CUDA1')).toBe(true);
});

test('no -dev means the dedicated cards; no -ngl means every layer', () => {
  const m = measurePlacement(input({ model: fakeModel({ layers: 12 }) }));
  expect([...new Set(m.layerDevice)]).toEqual(['CUDA0', 'CUDA1', 'Vulkan3']);
});

test('fitOf says fits, tight, then no as the model grows', () => {
  const verdict = (perLayer: number) =>
    fitOf(
      input({
        model: fakeModel({ layers: 40, otherBytesPerLayer: perLayer * MiB }),
        params: { dev: ['CUDA0'], ngl: 'all' },
      }),
    ).verdict;
  expect(verdict(300)).toBe('fits');
  expect(verdict(320)).toBe('tight');
  expect(verdict(420)).toBe('no');
  const unknown = fitOf(input({ params: { dev: ['CUDA7'] } }));
  expect(unknown.verdict).toBe('no');
  expect(unknown.reason).toContain('CUDA7');
});

test('RAM overflow is tight, never no (mmap reads the rest from disk)', () => {
  const f = fitOf(input({ params: { dev: ['CUDA0'], ngl: 'all', ncmoe: 48 }, ramAvailableBytes: 4 * GiB }));
  expect(f.verdict).toBe('tight');
  expect(f.reason).toContain('RAM');
});
