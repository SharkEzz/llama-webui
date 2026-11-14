import { assert, describe, it } from '@effect/vitest';
import type { TensorInfo } from './gguf.ts';
import { tensorBytes, weightSizes } from './sizes.ts';

const t = (name: string, bytes: number): TensorInfo => ({ name, shape: [bytes], dtype: 0, offset: 0, bytes });

describe('weightSizes', () => {
  it('shared experts stay with the layer (--n-cpu-moe moves only _exps / _chexps)', () => {
    const sizes = weightSizes([
      t('blk.0.ffn_up_exps.weight', 50),
      t('blk.0.ffn_down_chexps.weight', 20),
      t('blk.0.ffn_gate_shexp.weight', 7),
      t('blk.0.attn_q.weight', 3),
    ]);
    assert.deepStrictEqual(sizes.layers[0], { index: 0, expertsBytes: 70, otherBytes: 10 });
  });

  it('groups tensors by layer, experts apart', () => {
    const tensors = [
      t('token_embd.weight', 100),
      t('blk.0.attn_q.weight', 10),
      t('blk.0.ffn_gate_exps.weight', 50),
      t('blk.1.attn_q.weight', 10),
      t('output.weight', 100),
      t('output_norm.weight', 1),
    ];
    assert.deepStrictEqual(weightSizes(tensors), {
      layers: [
        { index: 0, expertsBytes: 50, otherBytes: 10 },
        { index: 1, expertsBytes: 0, otherBytes: 10 },
      ],
      embedBytes: 100,
      outputBytes: 100,
      otherBytes: 1,
      totalBytes: 271,
    });
  });
});

describe('tensorBytes', () => {
  it('last tensor ends at the end of the file', () => {
    assert.deepStrictEqual(tensorBytes([{ offset: 0 }, { offset: 64 }], 1000, 1200), [64, 136]);
  });
});
