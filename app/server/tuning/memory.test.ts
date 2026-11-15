import { assert, describe, it } from '@effect/vitest';
import { Array as Arr } from 'effect';
import { fakeModel } from '../testing/tuning.ts';
import { holdsKv, kvLayerBytes } from './memory.ts';

const f16 = { k: 'f16', v: 'f16' } as const;

describe('kvLayerBytes', () => {
  it('an f8_e4m3 KV cache takes half the bytes of an f16 one', () => {
    const dense = fakeModel({ layers: 36 });
    const full = kvLayerBytes(dense, { layer: 0, ctx: 65536, kv: f16 });
    assert.isAbove(full, 0);
    assert.strictEqual(kvLayerBytes(dense, { layer: 0, ctx: 65536, kv: { k: 'f8_e4m3', v: 'f8_e4m3' } }) * 2, full);
  });

  it('K and V are measured with their own types', () => {
    const dense = fakeModel({ layers: 4 });
    const mixed = kvLayerBytes(dense, { layer: 0, ctx: 4096, kv: { k: 'q8_0', v: 'f16' } });
    const both = kvLayerBytes(dense, { layer: 0, ctx: 4096, kv: { k: 'q8_0', v: 'q8_0' } });
    assert.isAbove(mixed, both);
    assert.isBelow(mixed, kvLayerBytes(dense, { layer: 0, ctx: 4096, kv: f16 }));
  });

  it('the MTP layers hold no KV cache', () => {
    const m = { ...fakeModel({ layers: 4 }), nextnLayers: 1 };
    assert.deepStrictEqual(
      Arr.map([0, 1, 2, 3], (i) => holdsKv(m, i)),
      [true, true, true, false],
    );
    assert.strictEqual(kvLayerBytes(m, { layer: 3, ctx: 4096, kv: f16 }), 0);
  });

  it('a recurrent model keeps a cache only on its full-attention layers', () => {
    const hybrid = { ...fakeModel({ layers: 8 }), recurrent: true, fullAttentionInterval: 4 };
    assert.deepStrictEqual(
      Arr.map([0, 1, 2, 3, 4, 5, 6, 7], (i) => holdsKv(hybrid, i)),
      [false, false, false, true, false, false, false, true],
    );
    // Without an interval (0 counts as none), a recurrent model has no KV cache at all.
    const pure = { ...fakeModel({ layers: 4 }), recurrent: true, fullAttentionInterval: 0 };
    assert.deepStrictEqual(
      Arr.map([0, 1, 2, 3], (i) => holdsKv(pure, i)),
      [false, false, false, false],
    );
  });

  it('a sliding-window layer caches the window, the full-attention one the whole context', () => {
    const m = { ...fakeModel({ layers: 6 }), slidingWindow: 1024, swaPattern: 3 };
    const window = kvLayerBytes(m, { layer: 0, ctx: 32768, kv: f16 });
    const full = kvLayerBytes(m, { layer: 2, ctx: 32768, kv: f16 });
    assert.strictEqual(full, window * 32);
    // Below the window, both cache the context.
    assert.strictEqual(
      kvLayerBytes(m, { layer: 0, ctx: 512, kv: f16 }),
      kvLayerBytes(m, { layer: 2, ctx: 512, kv: f16 }),
    );
  });
});
