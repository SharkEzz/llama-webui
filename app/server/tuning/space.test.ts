import { assert, describe, it } from '@effect/vitest';
import { SweepSpec, type SweepSpecInput, sweepCtx } from '@llama-webui/shared';
import { Effect, Schema } from 'effect';
import { fakeModel, hw3 } from '../testing/tuning.ts';
import { fitOf } from './placement.ts';
import { planSweep } from './space.ts';

const MiB = 1024 ** 2;
const moe = fakeModel({ layers: 48, experts: 128, expertBytesPerLayer: 300 * MiB, otherBytesPerLayer: 30 * MiB });
const specOf = (input: SweepSpecInput) => Schema.decodeEffect(SweepSpec)(input).pipe(Effect.orDie);

describe('planSweep', () => {
  it.effect('crosses -ncmoe with device sets and drops what does not fit unless asked', () =>
    Effect.gen(function* () {
      const spec = yield* specOf({
        name: 's',
        modelPath: '/m/fake.gguf',
        preset: 'chat',
        base: { ngl: 'all', fa: 'on' },
        space: { ncmoe: [0, 8, 16], dev: [['CUDA0'], ['CUDA0', 'CUDA1']] },
      });
      const plan = planSweep({ model: moe, hw: hw3(), spec, mmprojBytes: 0 });
      assert.lengthOf(plan.items, 4); // CUDA0 alone: -ncmoe 0 and 8 do not fit
      assert.strictEqual(plan.excluded, 2);
      assert.strictEqual(plan.items[0]?.label, '-ncmoe 0 · -dev CUDA0,CUDA1');
      assert.isAbove(plan.estimatedSeconds, 0);
      const all = planSweep({ model: moe, hw: hw3(), spec: { ...spec, includeUnfit: true }, mmprojBytes: 0 });
      assert.lengthOf(all.items, 6);
      assert.strictEqual(all.items[0]?.fit.verdict, 'no');
    }),
  );

  it.effect('measures an item with the V cache llama.cpp gives it: f16 when only -ctk is set', () =>
    Effect.gen(function* () {
      const spec = yield* specOf({
        name: 's',
        modelPath: '/m/fake.gguf',
        preset: 'chat',
        base: { ngl: 'all', dev: ['CUDA0', 'CUDA1'], ctk: 'q8_0' },
        space: { ncmoe: [0] },
      });
      const plan = planSweep({ model: moe, hw: hw3(), spec, mmprojBytes: 0 });
      const params = plan.items[0]?.params ?? {};
      const fitWith = (v: 'f16' | 'q8_0') =>
        fitOf({
          model: moe,
          devices: hw3().devices,
          params,
          ctx: sweepCtx(spec),
          kv: { k: 'q8_0', v },
          ub: 512,
          mmprojBytes: 0,
          ramAvailableBytes: hw3().ramAvailableBytes,
        });
      assert.deepStrictEqual(plan.items[0]?.fit, fitWith('f16'));
      assert.notDeepEqual(plan.items[0]?.fit, fitWith('q8_0'));
    }),
  );
});
