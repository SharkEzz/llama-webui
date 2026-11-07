import { afterAll, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from '../testing/tempDir';
import { ModelReadError, type ParsedShard, parseModel, readModel, type TensorInfo } from './gguf';
import { type FakeTensor, type KvValue, writeGguf } from './gguf.fixture';
import { tensorBytes, weightSizes } from './sizes';

const t = (name: string, bytes: number): TensorInfo => ({ name, shape: [bytes], dtype: 0, offset: 0, bytes });
const u32 = (value: number): KvValue => ({ type: 'u32', value });
const str = (value: string): KvValue => ({ type: 'string', value });

const tmp = tempDir('llt-gguf-');
afterAll(() => tmp[Symbol.dispose]());
const dir = tmp.path;

const DENSE_KV: Record<string, KvValue> = {
  'general.architecture': str('llama'),
  'general.name': str('Tiny'),
  'general.file_type': u32(15),
  'llama.block_count': u32(2),
  'llama.embedding_length': u32(64),
  'llama.attention.head_count': u32(4),
  'llama.attention.head_count_kv': u32(2),
  'llama.context_length': u32(4096),
  'llama.vocab_size': u32(100),
};
const DENSE_TENSORS: FakeTensor[] = [
  { name: 'token_embd.weight', shape: [64, 100], bytes: 6400 },
  { name: 'blk.0.attn_q.weight', shape: [64, 64], bytes: 4096 },
  { name: 'blk.0.ffn_up.weight', shape: [64, 128], bytes: 8192 },
  { name: 'blk.1.attn_q.weight', shape: [64, 64], bytes: 4096 },
  { name: 'blk.1.ffn_up.weight', shape: [64, 128], bytes: 8192 },
  { name: 'output_norm.weight', shape: [64], bytes: 64 },
  { name: 'output.weight', shape: [64, 100], bytes: 6400 },
];

describe('weightSizes', () => {
  test('shared experts stay with the layer (--n-cpu-moe moves only _exps / _chexps)', () => {
    const sizes = weightSizes([
      t('blk.0.ffn_up_exps.weight', 50),
      t('blk.0.ffn_down_chexps.weight', 20),
      t('blk.0.ffn_gate_shexp.weight', 7),
      t('blk.0.attn_q.weight', 3),
    ]);
    expect(sizes.layers[0]).toEqual({ index: 0, expertsBytes: 70, otherBytes: 10 });
  });

  test('groups tensors by layer, experts apart', () => {
    const tensors = [
      t('token_embd.weight', 100),
      t('blk.0.attn_q.weight', 10),
      t('blk.0.ffn_gate_exps.weight', 50),
      t('blk.1.attn_q.weight', 10),
      t('output.weight', 100),
      t('output_norm.weight', 1),
    ];
    expect(weightSizes(tensors)).toEqual({
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
  test('last tensor ends at the end of the file', () => {
    expect(tensorBytes([{ offset: 0 }, { offset: 64 }], 1000, 1200)).toEqual([64, 136]);
  });
});

describe('readModel', () => {
  test("reads a dense model's metadata and tensors", async () => {
    const path = join(dir, 'dense.gguf');
    await writeGguf(path, DENSE_KV, DENSE_TENSORS);
    const m = await readModel(path);
    expect({
      arch: m.arch,
      name: m.name,
      blockCount: m.blockCount,
      headCountKv: m.headCountKv,
      keyLength: m.keyLength,
      quant: m.quant,
      expertCount: m.expertCount,
      recurrent: m.recurrent,
      contextLength: m.contextLength,
      params: m.params,
    }).toEqual({
      arch: 'llama',
      name: 'Tiny',
      blockCount: 2,
      headCountKv: [2, 2],
      keyLength: 16,
      quant: 'Q4_K_M',
      expertCount: 0,
      recurrent: false,
      contextLength: 4096,
      params: 6400 + 4096 + 8192 + 4096 + 8192 + 64 + 6400,
    });
    expect(m.tensors.map((x) => [x.name, x.bytes])).toEqual(DENSE_TENSORS.map((x) => [x.name, x.bytes]));
    expect(m.files).toEqual([path]);
  });

  test('reads a hybrid model: full_attention_interval, ssm tensors, nextn layers', async () => {
    const path = join(dir, 'hybrid.gguf');
    await writeGguf(
      path,
      {
        ...DENSE_KV,
        'general.architecture': str('qwen35'),
        'qwen35.block_count': u32(2),
        'qwen35.embedding_length': u32(64),
        'qwen35.attention.head_count': u32(4),
        'qwen35.attention.head_count_kv': u32(2),
        'qwen35.attention.key_length': u32(32),
        'qwen35.attention.value_length': u32(32),
        'qwen35.full_attention_interval': u32(4),
        'qwen35.nextn_predict_layers': u32(1),
        'qwen35.ssm.inner_size': u32(8),
        'qwen35.ssm.state_size': u32(4),
        'qwen35.ssm.conv_kernel': u32(2),
      },
      [...DENSE_TENSORS, { name: 'blk.0.ssm_a', shape: [8], bytes: 32 }],
    );
    const m = await readModel(path);
    expect({
      fai: m.fullAttentionInterval,
      recurrent: m.recurrent,
      nextn: m.nextnLayers,
      k: m.keyLength,
      v: m.valueLength,
      ssm: m.ssmStateBytesPerSeq,
    }).toEqual({
      fai: 4,
      recurrent: true,
      nextn: 1,
      k: 32,
      v: 32,
      ssm: 2 * (8 * 4 + 2 * 8) * 4, // both layers are recurrent: 2 / 4 rounds down to no full-attention layer
    });
  });

  test('sums the shards of a -00001-of-00002 model', async () => {
    const p1 = join(dir, 'big-00001-of-00002.gguf');
    const p2 = join(dir, 'big-00002-of-00002.gguf');
    await writeGguf(p1, DENSE_KV, DENSE_TENSORS.slice(0, 3));
    await writeGguf(p2, { 'general.architecture': str('llama') }, DENSE_TENSORS.slice(3));
    const m = await readModel(p1);
    expect(m.files).toEqual([p1, p2]);
    expect(m.fileBytes).toBe(Bun.file(p1).size + Bun.file(p2).size);
    expect(m.tensors.map((x) => x.name)).toEqual(DENSE_TENSORS.map((x) => x.name));
    expect(m.blockCount).toBe(2);
  });

  test('a missing shard is a ModelReadError', async () => {
    const p1 = join(dir, 'lone-00001-of-00002.gguf');
    await writeGguf(p1, DENSE_KV, DENSE_TENSORS);
    await expect(readModel(p1)).rejects.toBeInstanceOf(ModelReadError);
  });

  test('an absent file is a ModelReadError', async () => {
    await expect(readModel(join(dir, 'nope.gguf'))).rejects.toBeInstanceOf(ModelReadError);
  });

  test('a file that is not a GGUF is a ModelReadError', async () => {
    const path = join(dir, 'junk.gguf');
    await Bun.write(path, 'hello');
    await expect(readModel(path)).rejects.toBeInstanceOf(ModelReadError);
  });

  test('the cache returns the same object until the file changes', async () => {
    const path = join(dir, 'cached.gguf');
    await writeGguf(path, DENSE_KV, DENSE_TENSORS);
    const a = await readModel(path);
    expect(await readModel(path)).toBe(a);
    await Bun.sleep(20);
    await writeGguf(path, DENSE_KV, DENSE_TENSORS.slice(0, 5));
    expect(await readModel(path)).not.toBe(a);
  });

  test('a changed second shard is re-read even when the first is untouched', async () => {
    const p1 = join(dir, 'two-00001-of-00002.gguf');
    const p2 = join(dir, 'two-00002-of-00002.gguf');
    await writeGguf(p1, DENSE_KV, DENSE_TENSORS.slice(0, 3));
    await writeGguf(p2, { 'general.architecture': str('llama') }, DENSE_TENSORS.slice(3));
    const a = await readModel(p1);
    await Bun.sleep(20);
    await writeGguf(p2, { 'general.architecture': str('llama') }, DENSE_TENSORS.slice(3, 5));
    const b = await readModel(p1);
    expect(b).not.toBe(a);
    expect(b.tensors.length).toBe(5);
  });

  test('the cache keeps the last 8 models only', async () => {
    const first = join(dir, 'many-0.gguf');
    await writeGguf(first, DENSE_KV, DENSE_TENSORS);
    const a = await readModel(first);
    for (let i = 1; i <= 8; i++) {
      const p = join(dir, `many-${i}.gguf`);
      await writeGguf(p, DENSE_KV, DENSE_TENSORS);
      await readModel(p);
    }
    expect(await readModel(first)).not.toBe(a);
  });

  test('a file behind a directory the user cannot enter is told apart from a missing one', async () => {
    if (process.getuid?.() === 0) return; // root enters anything
    const locked = join(dir, 'locked');
    mkdirSync(locked);
    const path = join(locked, 'm.gguf');
    await writeGguf(path, DENSE_KV, DENSE_TENSORS);
    chmodSync(locked, 0o000);
    try {
      await expect(readModel(path)).rejects.toThrow(/accès refusé/);
    } finally {
      chmodSync(locked, 0o755);
    }
  });
});

describe('vocabulary size', () => {
  const shard = (metadata: Record<string, unknown>, outputShape: number[] = [64, 7]): ParsedShard => ({
    metadata: { 'general.architecture': 'qwen35', ...metadata } as ParsedShard['metadata'],
    tensorInfos: [{ name: 'output.weight', shape: outputShape.map(BigInt), dtype: 0, offset: 0n }],
    tensorDataOffset: 0n,
  });
  const vocab = (s: ParsedShard) => parseModel('/m.gguf', [s], [100], 0).vocabSize;

  test('<arch>.vocab_size when present', () =>
    expect(vocab(shard({ 'qwen35.vocab_size': 9, 'tokenizer.ggml.tokens': ['a', 'b'] }))).toBe(9));
  test("else the tokenizer's token list (llama.cpp's own source)", () =>
    expect(vocab(shard({ 'tokenizer.ggml.tokens': ['a', 'b', 'c', 'd', 'e'] }))).toBe(5));
  test("else the output tensor's second dimension", () => expect(vocab(shard({}))).toBe(7));
  test("else the embedding tensor's", () => {
    const s = shard({});
    s.tensorInfos[0] = { name: 'token_embd.weight', shape: [64n, 11n], dtype: 0, offset: 0n };
    expect(vocab(s)).toBe(11);
  });
});

test('a multimodal projector is kind mmproj; a chat template is noticed', async () => {
  const mm = join(dir, 'mm.gguf');
  await writeGguf(mm, { 'general.architecture': str('clip'), 'general.type': str('mmproj') }, [
    { name: 'v.patch_embd.weight', shape: [4], bytes: 64 },
  ]);
  expect((await readModel(mm)).kind).toBe('mmproj');
  const chat = join(dir, 'chat.gguf');
  await writeGguf(chat, { ...DENSE_KV, 'tokenizer.chat_template': str('{{ messages }}') }, DENSE_TENSORS);
  const m = await readModel(chat);
  expect([m.kind, m.hasChatTemplate]).toEqual(['model', true]);
  expect((await readModel(join(dir, 'dense.gguf'))).hasChatTemplate).toBe(false);
});
