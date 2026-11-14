import { SweepSpecSchema } from '@llama-webui/shared';
import { expect, test } from 'vitest';
import { estimate } from './estimate';
import { fakeModel, hw3 } from './fixtures';
import { planSweep } from './space';

const MiB = 1024 ** 2;
const GiB = 1024 ** 3;

test('big preset puts experts on the CPU and uses the three cards', () => {
  const model = fakeModel({ layers: 48, experts: 128, expertBytesPerLayer: 2.1 * GiB, otherBytesPerLayer: 100 * MiB });
  expect(model.fileBytes).toBeGreaterThan(100 * GiB);
  const e = estimate({ model, hw: hw3(), preset: 'big', mmprojBytes: 0 });
  expect(e.ok).toBe(true);
  expect(e.params.dev).toEqual(['CUDA0', 'CUDA1', 'Vulkan3']);
  expect(e.params.ncmoe).toBeGreaterThan(0);
  expect(e.ramOverflowBytes).toBeGreaterThan(0);
  expect(e.diskReadBytesPerToken).toBeGreaterThan(0);
  expect(e.warnings.some((w) => w.includes('NVMe'))).toBe(true);
  expect(e.serverArgs).toContain('-ncmoe');
  expect(e.serverArgs.join(' ')).toContain('--fit off');
});

test('a dense model that fits on one card gets -ngl all and one CUDA device', () => {
  const e = estimate({
    model: fakeModel({ layers: 36, otherBytesPerLayer: 120 * MiB }),
    hw: hw3(),
    preset: 'chat',
    mmprojBytes: 0,
  });
  expect(e.ok).toBe(true);
  expect(e.params).toMatchObject({ ngl: 'all', dev: ['CUDA0'], fa: 'on', t: 6 });
  expect(e.params.ts).toBeUndefined();
  expect(e.ctx).toBe(32768);
  expect(e.fit.verdict).not.toBe('no');
});

test('a MoE that overflows one card is split before its experts go to RAM', () => {
  const model = fakeModel({ layers: 48, experts: 128, expertBytesPerLayer: 300 * MiB, otherBytesPerLayer: 30 * MiB });
  const e = estimate({ model, hw: hw3(), preset: 'chat', mmprojBytes: 0 });
  expect(e.params.dev).toEqual(['CUDA0', 'CUDA1']);
  expect(e.params.ncmoe).toBeUndefined();
  expect(e.params.ts?.length).toBe(2);
});

test('pinned values are kept, and -ncmoe on a dense model warns', () => {
  const e = estimate({
    model: fakeModel({ layers: 36 }),
    hw: hw3(),
    preset: 'chat',
    mmprojBytes: 0,
    pinned: { ncmoe: 4, dev: ['CUDA1'] },
  });
  expect(e.params.dev).toEqual(['CUDA1']);
  expect(e.params.ncmoe).toBe(4);
  expect(e.warnings.some((w) => w.includes('dense model'))).toBe(true);
});

test('planSweep crosses -ncmoe with device sets and drops what does not fit unless asked', () => {
  const model = fakeModel({ layers: 48, experts: 128, expertBytesPerLayer: 300 * MiB, otherBytesPerLayer: 30 * MiB });
  const spec = SweepSpecSchema.parse({
    name: 's',
    modelPath: '/m/fake.gguf',
    preset: 'chat',
    base: { ngl: 'all', fa: 'on' },
    space: { ncmoe: [0, 8, 16], dev: [['CUDA0'], ['CUDA0', 'CUDA1']] },
  });
  const plan = planSweep({ model, hw: hw3(), spec, mmprojBytes: 0 });
  expect(plan.items).toHaveLength(4); // CUDA0 alone: -ncmoe 0 and 8 do not fit
  expect(plan.excluded).toBe(2);
  expect(plan.items[0]!.label).toBe('-ncmoe 0 · -dev CUDA0,CUDA1');
  expect(plan.estimatedSeconds).toBeGreaterThan(0);
  const all = planSweep({ model, hw: hw3(), spec: { ...spec, includeUnfit: true }, mmprojBytes: 0 });
  expect(all.items).toHaveLength(6);
  expect(all.items[0]!.fit.verdict).toBe('no');
});

test('a CUDA pair with margin beats a single card at the limit, and the AMD card alone comes after the CUDA pair', () => {
  for (const mb of [310, 325]) {
    const e = estimate({
      model: fakeModel({ layers: 36, otherBytesPerLayer: mb * MiB }),
      hw: hw3(),
      preset: 'chat',
      mmprojBytes: 0,
    });
    expect({ mb, dev: e.params.dev, verdict: e.fit.verdict }).toEqual({ mb, dev: ['CUDA0', 'CUDA1'], verdict: 'fits' });
    expect(e.ctx).toBe(32768);
  }
});

test('pinned -fa and -ctk show up in the rows and the kv field, not the searched values (#36)', () => {
  const e = estimate({
    model: fakeModel({ layers: 36, otherBytesPerLayer: 120 * MiB }),
    hw: hw3(),
    preset: 'chat',
    mmprojBytes: 0,
    pinned: { fa: 'auto', ctk: 'q4_0' },
  });
  const args = e.serverArgs.join(' ');
  expect(args).toContain('-fa auto');
  expect(args).toContain('-ctk q4_0');
  const row = (flag: string) => e.rows.find((r) => r.flag === flag);
  expect(row('-fa')?.value).toBe('auto');
  const ctv = e.params.ctv;
  expect(row('-ctk / -ctv')?.value).toBe(ctv === 'q4_0' ? 'q4_0' : `q4_0 / ${ctv}`);
  expect(row('-c')?.why).toContain('q4_0');
  expect(e.kv).toBe('q4_0');
});

test('an -ot rule to an unknown device is reported and does not fit (#36)', () => {
  const model = fakeModel({ layers: 48, experts: 128, expertBytesPerLayer: 300 * MiB, otherBytesPerLayer: 30 * MiB });
  const e = estimate({ model, hw: hw3(), preset: 'chat', mmprojBytes: 0, pinned: { ot: ['exps=CUDA7'] } });
  expect(e.fit.verdict).toBe('no');
  expect(e.warnings.some((w) => w.includes('CUDA7'))).toBe(true);
});

test('when nothing fits because of RAM, the reason names RAM, not the all-GPU fallback (#25)', () => {
  // 72 GiB of experts: too much for the three cards, so experts must go to RAM, but only 10 GiB is available.
  const model = fakeModel({ layers: 48, experts: 128, expertBytesPerLayer: 1.5 * GiB, otherBytesPerLayer: 50 * MiB });
  const e = estimate({ model, hw: hw3({ ramAvailableGiB: 10 }), preset: 'fit', mmprojBytes: 0 });
  expect(e.ok).toBe(false);
  expect(e.reason).toMatch(/^not enough RAM: .* needed with weights in RAM, 10\.0 GiB available$/);
  // The per-device detail of the fallback stays on the bars.
  expect(e.fit.vram.length).toBeGreaterThan(0);
});

test('with -fa off, an f8_e4m3 cache keeps the model on a CUDA card where f16 does not fit', () => {
  const model = fakeModel({ layers: 36, otherBytesPerLayer: 200 * MiB });
  const e = estimate({
    model,
    hw: hw3(),
    preset: 'chat',
    mmprojBytes: 0,
    ctx: 131072,
    pinned: { fa: 'off', dev: ['CUDA0'] },
  });
  expect(e.params).toMatchObject({ ngl: 'all', dev: ['CUDA0'], fa: 'off', ctk: 'f8_e4m3', ctv: 'f8_e4m3' });
  expect(e.kv).toBe('f8_e4m3');
  expect(e.rows.find((r) => r.flag === '-ctk / -ctv')?.why).toBe('cache halved, works without flash attention');
  expect(e.warnings.some((w) => w.includes('flash attention'))).toBe(false);
});

test('with -fa off, the estimator never picks f8_e4m3 on a Vulkan card', () => {
  const model = fakeModel({ layers: 36, otherBytesPerLayer: 200 * MiB });
  const e = estimate({
    model,
    hw: hw3(),
    preset: 'chat',
    mmprojBytes: 0,
    ctx: 131072,
    pinned: { fa: 'off', dev: ['Vulkan3'] },
  });
  expect(e.params.ctk).toBe('f16');
  expect(e.params.ctv).toBe('f16');
});

test('with -fa off and the largest context, f8_e4m3 only wins when f16 cannot reach the model context', () => {
  const pinned = { fa: 'off' as const, dev: ['CUDA0'] };
  const small = estimate({ model: fakeModel({ layers: 36 }), hw: hw3(), preset: 'context', mmprojBytes: 0, pinned });
  expect(small.params).toMatchObject({ ngl: 'all', ctk: 'f16', ctv: 'f16' });
  expect(small.ctx).toBe(131072);
  // 32 KV heads: f16 cannot hold the 131072 tokens of the model, f8_e4m3 goes further.
  const model = { ...fakeModel({ layers: 36, otherBytesPerLayer: 200 * MiB }), headCountKv: Array(36).fill(32) };
  const f16 = estimate({
    model,
    hw: hw3(),
    preset: 'context',
    mmprojBytes: 0,
    pinned: { ...pinned, ctk: 'f16', ctv: 'f16' },
  });
  const big = estimate({ model, hw: hw3(), preset: 'context', mmprojBytes: 0, pinned });
  expect(big.params).toMatchObject({ ctk: 'f8_e4m3', ctv: 'f8_e4m3' });
  expect(big.ctx).toBeGreaterThan(f16.ctx);
});

test('a pinned f8_e4m3 cache is not called quantized and warns on a Vulkan card', () => {
  const model = fakeModel({ layers: 36, otherBytesPerLayer: 120 * MiB });
  const pinned = { fa: 'on' as const, ctk: 'f8_e4m3' as const, ctv: 'f8_e4m3' as const };
  const cuda = estimate({ model, hw: hw3(), preset: 'chat', mmprojBytes: 0, pinned: { ...pinned, dev: ['CUDA0'] } });
  expect(cuda.rows.find((r) => r.flag === '-fa')?.why).toBe('faster attention, smaller compute buffers');
  expect(cuda.warnings.some((w) => w.includes('f8_e4m3'))).toBe(false);
  const vulkan = estimate({
    model,
    hw: hw3(),
    preset: 'chat',
    mmprojBytes: 0,
    pinned: { ...pinned, dev: ['Vulkan3'] },
  });
  expect(vulkan.params.ctk).toBe('f8_e4m3');
  expect(vulkan.warnings).toContain('only CUDA and the CPU support an f8_e4m3 KV cache: Vulkan3 may fail');
});
