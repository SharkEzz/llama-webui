import { expect, test } from 'bun:test';
import { SweepSpecSchema } from '@llama-webui/shared';
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
  expect(e.warnings.some((w) => w.includes('modèle dense'))).toBe(true);
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
  expect(plan.items).toHaveLength(4); // CUDA0 seule : -ncmoe 0 et 8 ne tiennent pas
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
