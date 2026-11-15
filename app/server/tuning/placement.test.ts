import { assert, describe, it } from '@effect/vitest';
import { deviceRole } from '@llama-webui/shared';
import { Array as Arr, String as Str } from 'effect';
import { fakeModel, hw3 } from '../testing/tuning.ts';
import { fitOf, measurePlacement, type PlacementInput } from './placement.ts';

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

describe('deviceRole', () => {
  it('skips the Vulkan copies of the CUDA cards and the iGPU', () => {
    const all = hw3().devices;
    assert.deepStrictEqual(
      Arr.map(all, (d) => deviceRole(d, all)),
      ['gpu', 'gpu', 'integrated', 'duplicate', 'duplicate', 'gpu', 'host'],
    );
  });

  it('treats the ROCm iGPU as integrated and the Vulkan copy of a ROCm card as a duplicate (#22)', () => {
    const dev = (id: string, name: string, totalMib: number) => ({
      id,
      name,
      totalMib,
      freeMib: totalMib,
      backend: Str.replace(/\d+$/, '')(id),
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
    assert.deepStrictEqual(
      Arr.map(all, (d) => deviceRole(d, all)),
      ['host', 'gpu', 'gpu', 'gpu', 'integrated', 'duplicate', 'gpu'],
    );
  });
});

describe('measurePlacement', () => {
  it('-ncmoe moves the experts of the first N layers to RAM', () => {
    const m = measurePlacement(input({ params: { dev: ['CUDA0'], ngl: 'all', ncmoe: 8 } }));
    assert.strictEqual(m.cpuExpertsBytes, 8 * 300 * MiB);
    assert.strictEqual(m.ram, 8 * 300 * MiB + 300 * MiB); // experts + token_embd
    assert.deepStrictEqual([...m.vram.keys()], ['CUDA0']);
    const weightsOnGpu = 40 * 300 * MiB + 48 * 30 * MiB + 301 * MiB;
    assert.strictEqual(m.gpuWeights, weightsOnGpu);
    assert.isAbove(m.vram.get('CUDA0') ?? 0, weightsOnGpu);
  });

  it('-ot wins over -ngl and -ts splits the layers in order', () => {
    const m = measurePlacement(
      input({ params: { dev: ['CUDA0', 'CUDA1'], ts: [3, 1], ngl: 'all', ot: ['ffn_.*_exps=CPU'] } }),
    );
    assert.strictEqual(m.cpuExpertsBytes, 48 * 300 * MiB);
    assert.isTrue(Arr.every(m.layerDevice.slice(0, 36), (d) => d === 'CUDA0'));
    assert.isTrue(Arr.every(m.layerDevice.slice(36), (d) => d === 'CUDA1'));
  });

  it('no -dev means the dedicated cards; no -ngl means every layer', () => {
    const m = measurePlacement(input({ model: fakeModel({ layers: 12 }) }));
    assert.deepStrictEqual([...new Set(m.layerDevice)], ['CUDA0', 'CUDA1', 'Vulkan3']);
  });

  it('-ot to an unknown device is an issue, to a host buffer is RAM (#36)', () => {
    const unknown = measurePlacement(input({ params: { dev: ['CUDA0'], ot: ['exps=CUDA7'] } }));
    assert.deepStrictEqual(unknown.issues, ['unknown device: CUDA7 (-ot exps=CUDA7)']);
    assert.strictEqual(fitOf(input({ params: { dev: ['CUDA0'], ot: ['exps=CUDA7'] } })).verdict, 'no');
    const host = measurePlacement(input({ params: { dev: ['CUDA0'], ot: ['exps=CPU', 'norm=CUDA_Host'] } }));
    assert.deepStrictEqual(host.issues, []);
    assert.strictEqual(host.cpuExpertsBytes, 48 * 300 * MiB);
  });

  it('an -ot pattern that is not a regular expression is an issue, and the rule is ignored', () => {
    const m = measurePlacement(input({ params: { dev: ['CUDA0'], ngl: 'all', ot: ['exps[=CPU'] } }));
    assert.deepStrictEqual(m.issues, ['invalid -ot pattern: exps[']);
    assert.strictEqual(m.cpuExpertsBytes, 0);
  });
});

describe('fitOf', () => {
  it('says fits, tight, then no as the model grows', () => {
    const verdict = (perLayer: number) =>
      fitOf(
        input({
          model: fakeModel({ layers: 40, otherBytesPerLayer: perLayer * MiB }),
          params: { dev: ['CUDA0'], ngl: 'all' },
        }),
      ).verdict;
    assert.strictEqual(verdict(300), 'fits');
    assert.strictEqual(verdict(320), 'tight');
    assert.strictEqual(verdict(420), 'no');
    const unknown = fitOf(input({ params: { dev: ['CUDA7'] } }));
    assert.strictEqual(unknown.verdict, 'no');
    assert.include(unknown.reason ?? '', 'CUDA7');
  });

  it('a RAM overflow is tight, never no (mmap reads the rest from disk)', () => {
    const f = fitOf(input({ params: { dev: ['CUDA0'], ngl: 'all', ncmoe: 48 }, ramAvailableBytes: 4 * GiB }));
    assert.strictEqual(f.verdict, 'tight');
    assert.include(f.reason ?? '', 'RAM');
  });
});
