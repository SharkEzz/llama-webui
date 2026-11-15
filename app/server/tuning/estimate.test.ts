import { assert, describe, it } from '@effect/vitest';
import type { BenchParams } from '@llama-webui/shared';
import { Array as Arr, Option, String as Str } from 'effect';
import { fakeModel, hw3 } from '../testing/tuning.ts';
import { type EstimateInput, estimate } from './estimate.ts';

const MiB = 1024 ** 2;
const GiB = 1024 ** 3;

const run = (o: Partial<EstimateInput> & Pick<EstimateInput, 'model'>) =>
  estimate({ hw: hw3(), preset: 'chat', mmprojBytes: 0, ...o });
const rowOf = (e: ReturnType<typeof estimate>, flag: string) => Arr.findFirst(e.rows, (r) => r.flag === flag);
const hasWarning = (e: ReturnType<typeof estimate>, text: string) => Arr.some(e.warnings, Str.includes(text));
const cpuOnly = { ...hw3(), devices: Arr.filter(hw3().devices, (d) => d.id === 'BLAS') };

describe('estimate', () => {
  it('the big preset puts experts on the CPU and uses the three cards', () => {
    const model = fakeModel({
      layers: 48,
      experts: 128,
      expertBytesPerLayer: 2.1 * GiB,
      otherBytesPerLayer: 100 * MiB,
    });
    assert.isAbove(model.fileBytes, 100 * GiB);
    const e = run({ model, preset: 'big' });
    assert.isTrue(e.ok);
    assert.deepStrictEqual(e.params.dev, ['CUDA0', 'CUDA1', 'Vulkan3']);
    assert.isAbove(e.params.ncmoe ?? 0, 0);
    assert.isAbove(e.ramOverflowBytes, 0);
    assert.isAbove(e.diskReadBytesPerToken, 0);
    assert.isTrue(hasWarning(e, 'NVMe'));
    assert.include(e.serverArgs, '-ncmoe');
    assert.include(Arr.join(e.serverArgs, ' '), '--fit off');
  });

  it('a dense model that fits on one card gets -ngl all and one CUDA device', () => {
    const e = run({ model: fakeModel({ layers: 36, otherBytesPerLayer: 120 * MiB }) });
    assert.isTrue(e.ok);
    assert.deepInclude(e.params, { ngl: 'all', fa: 'on', t: 6 });
    assert.deepStrictEqual(e.params.dev, ['CUDA0']);
    assert.isUndefined(e.params.ts);
    assert.strictEqual(e.ctx, 32768);
    assert.notStrictEqual(e.fit.verdict, 'no');
  });

  it('a MoE that overflows one card is split before its experts go to RAM', () => {
    const model = fakeModel({ layers: 48, experts: 128, expertBytesPerLayer: 300 * MiB, otherBytesPerLayer: 30 * MiB });
    const e = run({ model });
    assert.deepStrictEqual(e.params.dev, ['CUDA0', 'CUDA1']);
    assert.isUndefined(e.params.ncmoe);
    assert.lengthOf(e.params.ts ?? [], 2);
  });

  it('pinned values are kept, and -ncmoe on a dense model warns', () => {
    const e = run({ model: fakeModel({ layers: 36 }), pinned: { ncmoe: 4, dev: ['CUDA1'] } });
    assert.deepStrictEqual(e.params.dev, ['CUDA1']);
    assert.strictEqual(e.params.ncmoe, 4);
    assert.isTrue(hasWarning(e, 'dense model'));
  });

  it('a CUDA pair with margin beats a single card at the limit, and the AMD card alone comes after the CUDA pair', () => {
    for (const mb of [310, 325]) {
      const e = run({ model: fakeModel({ layers: 36, otherBytesPerLayer: mb * MiB }) });
      assert.deepStrictEqual(
        { mb, dev: e.params.dev, verdict: e.fit.verdict },
        { mb, dev: ['CUDA0', 'CUDA1'], verdict: 'fits' },
      );
      assert.strictEqual(e.ctx, 32768);
    }
  });

  it('pinned -fa and -ctk show up in the rows and the kv field, not the searched values (#36)', () => {
    const e = run({
      model: fakeModel({ layers: 36, otherBytesPerLayer: 120 * MiB }),
      pinned: { fa: 'auto', ctk: 'q4_0' },
    });
    const args = Arr.join(e.serverArgs, ' ');
    assert.include(args, '-fa auto');
    assert.include(args, '-ctk q4_0');
    assert.strictEqual(Option.getOrThrow(rowOf(e, '-fa')).value, 'auto');
    const ctv = e.params.ctv;
    assert.strictEqual(Option.getOrThrow(rowOf(e, '-ctk / -ctv')).value, ctv === 'q4_0' ? 'q4_0' : `q4_0 / ${ctv}`);
    assert.include(Option.getOrThrow(rowOf(e, '-c')).why, 'q4_0');
    assert.strictEqual(e.kv, 'q4_0');
  });

  it('an -ot rule to an unknown device is reported and does not fit (#36)', () => {
    const model = fakeModel({ layers: 48, experts: 128, expertBytesPerLayer: 300 * MiB, otherBytesPerLayer: 30 * MiB });
    const e = run({ model, pinned: { ot: ['exps=CUDA7'] } });
    assert.strictEqual(e.fit.verdict, 'no');
    assert.isTrue(hasWarning(e, 'CUDA7'));
  });

  it('when nothing fits because of RAM, the reason names RAM, not the all-GPU fallback (#25)', () => {
    // 72 GiB of experts: too much for the three cards, so experts must go to RAM, but only 10 GiB is available.
    const model = fakeModel({ layers: 48, experts: 128, expertBytesPerLayer: 1.5 * GiB, otherBytesPerLayer: 50 * MiB });
    const e = run({ model, hw: hw3({ ramAvailableGiB: 10 }), preset: 'fit' });
    assert.isFalse(e.ok);
    assert.match(e.reason ?? '', /^not enough RAM: .* needed with weights in RAM, 10\.0 GiB available$/);
    // The per-device detail of the fallback stays on the bars.
    assert.isAbove(e.fit.vram.length, 0);
  });

  it('with -fa off, an f8_e4m3 cache keeps the model on a CUDA card where f16 does not fit', () => {
    const model = fakeModel({ layers: 36, otherBytesPerLayer: 200 * MiB });
    const e = run({ model, ctx: 131072, pinned: { fa: 'off', dev: ['CUDA0'] } });
    assert.deepInclude(e.params, { ngl: 'all', fa: 'off', ctk: 'f8_e4m3', ctv: 'f8_e4m3' });
    assert.deepStrictEqual(e.params.dev, ['CUDA0']);
    assert.strictEqual(e.kv, 'f8_e4m3');
    assert.strictEqual(Option.getOrThrow(rowOf(e, '-ctk / -ctv')).why, 'cache halved, works without flash attention');
    assert.isFalse(hasWarning(e, 'flash attention'));
  });

  it('with -fa off, the estimator never picks f8_e4m3 on a Vulkan card', () => {
    const model = fakeModel({ layers: 36, otherBytesPerLayer: 200 * MiB });
    const e = run({ model, ctx: 131072, pinned: { fa: 'off', dev: ['Vulkan3'] } });
    assert.strictEqual(e.params.ctk, 'f16');
    assert.strictEqual(e.params.ctv, 'f16');
  });

  it('with -fa off and the largest context, f8_e4m3 only wins when f16 cannot reach the model context', () => {
    const pinned: BenchParams = { fa: 'off', dev: ['CUDA0'] };
    const small = run({ model: fakeModel({ layers: 36 }), preset: 'context', pinned });
    assert.deepInclude(small.params, { ngl: 'all', ctk: 'f16', ctv: 'f16' });
    assert.strictEqual(small.ctx, 131072);
    // 32 KV heads: f16 cannot hold the 131072 tokens of the model, f8_e4m3 goes further.
    const model = { ...fakeModel({ layers: 36, otherBytesPerLayer: 200 * MiB }), headCountKv: Arr.replicate(32, 36) };
    const f16 = run({ model, preset: 'context', pinned: { ...pinned, ctk: 'f16', ctv: 'f16' } });
    const big = run({ model, preset: 'context', pinned });
    assert.deepInclude(big.params, { ctk: 'f8_e4m3', ctv: 'f8_e4m3' });
    assert.isAbove(big.ctx, f16.ctx);
  });

  it('a pinned f8_e4m3 cache is not called quantized and warns on a Vulkan card', () => {
    const model = fakeModel({ layers: 36, otherBytesPerLayer: 120 * MiB });
    const pinned: BenchParams = { fa: 'on', ctk: 'f8_e4m3', ctv: 'f8_e4m3' };
    const cuda = run({ model, pinned: { ...pinned, dev: ['CUDA0'] } });
    assert.strictEqual(Option.getOrThrow(rowOf(cuda, '-fa')).why, 'faster attention, smaller compute buffers');
    assert.isFalse(hasWarning(cuda, 'f8_e4m3'));
    const vulkan = run({ model, pinned: { ...pinned, dev: ['Vulkan3'] } });
    assert.strictEqual(vulkan.params.ctk, 'f8_e4m3');
    assert.include(vulkan.warnings, 'only CUDA and the CPU support an f8_e4m3 KV cache: Vulkan3 may fail');
  });

  it('a partial offload with RAM to spare recommends --mlock and warns of slow generation', () => {
    const e = run({ model: fakeModel({ layers: 60, otherBytesPerLayer: 500 * MiB }), pinned: { dev: ['CUDA0'] } });
    assert.isTrue(e.ok);
    assert.strictEqual(e.params.ngl, 25);
    assert.include(e.serverArgs, '--mlock');
    assert.isTrue(Option.isSome(rowOf(e, '--mlock')));
    assert.include(e.warnings, 'slow generation: 35 of 60 layers in RAM');
  });

  it('several NUMA nodes add --numa distribute', () => {
    const e = run({
      model: fakeModel({ layers: 36, otherBytesPerLayer: 120 * MiB }),
      hw: { ...hw3(), cpu: { ...hw3().cpu, numaNodes: 2 } },
    });
    assert.include(Arr.join(e.serverArgs, ' '), '--numa distribute');
    assert.strictEqual(Option.getOrThrow(rowOf(e, '--numa')).value, 'distribute');
    assert.notInclude(run({ model: fakeModel({ layers: 36, otherBytesPerLayer: 120 * MiB }) }).serverArgs, '--numa');
  });

  it('without a GPU, everything runs in RAM', () => {
    const e = run({ model: fakeModel({ layers: 36, otherBytesPerLayer: 120 * MiB }), hw: cpuOnly });
    assert.isTrue(e.ok);
    assert.deepInclude(e.params, { ngl: 0 });
    assert.deepStrictEqual(e.params.dev, ['none']);
    assert.include(e.warnings, 'not enough VRAM: everything in RAM');
  });

  it('a pinned context of 0 counts as none', () => {
    const model = fakeModel({ layers: 36, otherBytesPerLayer: 120 * MiB });
    assert.strictEqual(run({ model, ctx: 0 }).ctx, run({ model }).ctx);
  });
});
