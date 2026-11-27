import * as NodeServices from '@effect/platform-node/NodeServices';
import { assert, describe, it, layer } from '@effect/vitest';
import { Array as Arr, Effect, FileSystem, Layer, Path } from 'effect';
import { type FakeTensor, type KvValue, writeGguf } from '../testing/gguf.ts';
import { type ParsedShard, parseModel } from './gguf.ts';
import { GgufReader } from './GgufReader.ts';

const u32 = (value: number): KvValue => ({ type: 'u32', value });
const str = (value: string): KvValue => ({ type: 'string', value });

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

/** A folder of the test's own, removed at its end, and a way to write a GGUF in it. */
const workspace = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = yield* fs.makeTempDirectoryScoped({ prefix: 'lw-gguf-' });
  /** Writes `name` under the folder and gives its path. */
  const write = (name: string, kv: Record<string, KvValue>, tensors: FakeTensor[]) =>
    Effect.promise(() => writeGguf(path.join(dir, name), kv, tensors)).pipe(Effect.as(path.join(dir, name)));
  return { fs, dir, at: (name: string) => path.join(dir, name), write };
});

/** The read of `path`, failed or not, as its `ModelReadError`. */
const readError = Effect.fnUntraced(function* (path: string) {
  const reader = yield* GgufReader;
  const error = yield* Effect.flip(reader.read(path));
  assert.strictEqual(error._tag, 'ModelReadError');
  return error.message;
});

const Live = GgufReader.layer.pipe(Layer.provideMerge(NodeServices.layer));

layer(Live, { excludeTestServices: true })('readModel', (it) => {
  it.effect("reads a dense model's metadata and tensors", () =>
    Effect.gen(function* () {
      const { write } = yield* workspace;
      const path = yield* write('dense.gguf', DENSE_KV, DENSE_TENSORS);
      const reader = yield* GgufReader;
      const m = yield* reader.read(path);
      assert.deepStrictEqual(
        {
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
        },
        {
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
        },
      );
      assert.deepStrictEqual(
        Arr.map(m.tensors, (x) => [x.name, x.bytes]),
        Arr.map(DENSE_TENSORS, (x) => [x.name, x.bytes]),
      );
      assert.deepStrictEqual(m.files, [path]);
    }),
  );

  it.effect('reads a hybrid model: full_attention_interval, ssm tensors, nextn layers', () =>
    Effect.gen(function* () {
      const { write } = yield* workspace;
      const path = yield* write(
        'hybrid.gguf',
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
      const reader = yield* GgufReader;
      const m = yield* reader.read(path);
      assert.deepStrictEqual(
        {
          fai: m.fullAttentionInterval,
          recurrent: m.recurrent,
          nextn: m.nextnLayers,
          k: m.keyLength,
          v: m.valueLength,
          ssm: m.ssmStateBytesPerSeq,
        },
        {
          fai: 4,
          recurrent: true,
          nextn: 1,
          k: 32,
          v: 32,
          ssm: 2 * (8 * 4 + 2 * 8) * 4, // both layers are recurrent: 2 / 4 rounds down to no full-attention layer
        },
      );
    }),
  );

  it.effect('sums the shards of a -00001-of-00002 model', () =>
    Effect.gen(function* () {
      const { fs, write } = yield* workspace;
      const p1 = yield* write('big-00001-of-00002.gguf', DENSE_KV, Arr.take(DENSE_TENSORS, 3));
      const p2 = yield* write(
        'big-00002-of-00002.gguf',
        { 'general.architecture': str('llama') },
        Arr.drop(DENSE_TENSORS, 3),
      );
      const reader = yield* GgufReader;
      const m = yield* reader.read(p1);
      assert.deepStrictEqual(m.files, [p1, p2]);
      const [s1, s2] = yield* Effect.forEach([p1, p2], (p) => fs.stat(p));
      assert.strictEqual(m.fileBytes, Number(s1!.size) + Number(s2!.size));
      assert.deepStrictEqual(
        Arr.map(m.tensors, (x) => x.name),
        Arr.map(DENSE_TENSORS, (x) => x.name),
      );
      assert.strictEqual(m.blockCount, 2);
    }),
  );

  it.effect('a missing shard is a ModelReadError', () =>
    Effect.gen(function* () {
      const { write, at } = yield* workspace;
      const p1 = yield* write('lone-00001-of-00002.gguf', DENSE_KV, DENSE_TENSORS);
      const message = yield* readError(p1);
      assert.strictEqual(message, `file not found: ${at('lone-00002-of-00002.gguf')}`);
    }),
  );

  it.effect('an absent file is a ModelReadError', () =>
    Effect.gen(function* () {
      const { at } = yield* workspace;
      const message = yield* readError(at('nope.gguf'));
      assert.strictEqual(message, `file not found: ${at('nope.gguf')}`);
    }),
  );

  it.effect('a file that is not a GGUF is a ModelReadError', () =>
    Effect.gen(function* () {
      const { fs, at } = yield* workspace;
      yield* fs.writeFileString(at('junk.gguf'), 'hello');
      const message = yield* readError(at('junk.gguf'));
      assert.match(message, /^unreadable GGUF: ./);
    }),
  );

  it.effect('a path through a regular file is file not found (ENOTDIR)', () =>
    Effect.gen(function* () {
      const { write, at } = yield* workspace;
      const file = yield* write('plain.gguf', DENSE_KV, DENSE_TENSORS);
      const message = yield* readError(`${file}/inner.gguf`);
      assert.strictEqual(message, `file not found: ${at('plain.gguf')}/inner.gguf`);
    }),
  );

  it.effect('the cache returns the same object until the file changes', () =>
    Effect.gen(function* () {
      const { write } = yield* workspace;
      const path = yield* write('cached.gguf', DENSE_KV, DENSE_TENSORS);
      const reader = yield* GgufReader;
      const a = yield* reader.read(path);
      const again = yield* reader.read(path);
      assert.strictEqual(again, a);
      yield* Effect.sleep('20 millis');
      yield* write('cached.gguf', DENSE_KV, Arr.take(DENSE_TENSORS, 5));
      const changed = yield* reader.read(path);
      assert.notStrictEqual(changed, a);
    }),
  );

  it.effect('a changed second shard is re-read even when the first is untouched', () =>
    Effect.gen(function* () {
      const { write } = yield* workspace;
      const p1 = yield* write('two-00001-of-00002.gguf', DENSE_KV, Arr.take(DENSE_TENSORS, 3));
      const arch = { 'general.architecture': str('llama') };
      yield* write('two-00002-of-00002.gguf', arch, Arr.drop(DENSE_TENSORS, 3));
      const reader = yield* GgufReader;
      const a = yield* reader.read(p1);
      yield* Effect.sleep('20 millis');
      yield* write('two-00002-of-00002.gguf', arch, Arr.take(Arr.drop(DENSE_TENSORS, 3), 2));
      const b = yield* reader.read(p1);
      assert.notStrictEqual(b, a);
      assert.strictEqual(b.tensors.length, 5);
    }),
  );

  it.effect('the cache keeps the last 8 models only', () =>
    Effect.gen(function* () {
      const { write } = yield* workspace;
      const reader = yield* GgufReader;
      const first = yield* write('many-0.gguf', DENSE_KV, DENSE_TENSORS);
      const a = yield* reader.read(first);
      for (let i = 1; i <= 8; i++) {
        const p = yield* write(`many-${i}.gguf`, DENSE_KV, DENSE_TENSORS);
        yield* reader.read(p);
      }
      const again = yield* reader.read(first);
      assert.notStrictEqual(again, a);
    }),
  );

  it.effect('a failed read is not cached: the file fixed, the next read succeeds', () =>
    Effect.gen(function* () {
      const { fs, write, at } = yield* workspace;
      const source = yield* write('good.gguf', DENSE_KV, DENSE_TENSORS);
      const good = yield* fs.readFile(source);
      // The same size and the same mtime before and after the fix: the stamp does not change, only the content.
      const path = at('fixed.gguf');
      const when = 1_700_000_000; // seconds
      yield* fs.writeFile(path, new Uint8Array(good.length));
      yield* fs.utimes(path, when, when);
      const reader = yield* GgufReader;
      const before = yield* reader.stamp(path);
      const message = yield* readError(path);
      assert.match(message, /^unreadable GGUF: /);
      yield* fs.writeFile(path, good);
      yield* fs.utimes(path, when, when);
      const after = yield* reader.stamp(path);
      assert.strictEqual(after, before);
      const m = yield* reader.read(path);
      assert.strictEqual(m.name, 'Tiny');
    }),
  );

  it.effect.skipIf(process.getuid?.() === 0)(
    'a file behind a directory the user cannot enter is told apart from a missing one',
    () =>
      Effect.gen(function* () {
        const { fs, write, at } = yield* workspace;
        yield* fs.makeDirectory(at('locked'));
        const path = yield* write('locked/m.gguf', DENSE_KV, DENSE_TENSORS);
        yield* fs.chmod(at('locked'), 0o000);
        const message = yield* readError(path).pipe(Effect.ensuring(Effect.orDie(fs.chmod(at('locked'), 0o755))));
        assert.strictEqual(message, `permission denied: ${path}`);
      }),
  );

  it.effect('a multimodal projector is kind mmproj; a chat template is noticed', () =>
    Effect.gen(function* () {
      const { write } = yield* workspace;
      const reader = yield* GgufReader;
      const mm = yield* write('mm.gguf', { 'general.architecture': str('clip'), 'general.type': str('mmproj') }, [
        { name: 'v.patch_embd.weight', shape: [4], bytes: 64 },
      ]);
      assert.strictEqual((yield* reader.read(mm)).kind, 'mmproj');
      const chat = yield* write(
        'chat.gguf',
        { ...DENSE_KV, 'tokenizer.chat_template': str('{{ messages }}') },
        DENSE_TENSORS,
      );
      const m = yield* reader.read(chat);
      assert.deepStrictEqual([m.kind, m.hasChatTemplate], ['model', true]);
      const dense = yield* write('dense.gguf', DENSE_KV, DENSE_TENSORS);
      assert.strictEqual((yield* reader.read(dense)).hasChatTemplate, false);
    }),
  );

  it.effect('the stamp is the mtime in ms and the size of every part', () =>
    Effect.gen(function* () {
      const { fs, write } = yield* workspace;
      const p1 = yield* write('st-00001-of-00002.gguf', DENSE_KV, Arr.take(DENSE_TENSORS, 3));
      const p2 = yield* write(
        'st-00002-of-00002.gguf',
        { 'general.architecture': str('llama') },
        Arr.drop(DENSE_TENSORS, 3),
      );
      // In seconds, with fractions a double holds exactly (.125, .5).
      yield* fs.utimes(p1, 1_700_000_000.125, 1_700_000_000.125);
      yield* fs.utimes(p2, 1_700_000_000.5, 1_700_000_000.5);
      const [s1, s2] = yield* Effect.forEach([p1, p2], (p) => fs.stat(p));
      const reader = yield* GgufReader;
      const stamp = yield* reader.stamp(p1);
      assert.strictEqual(stamp, `1700000000125:${Number(s1!.size)}|1700000000500:${Number(s2!.size)}`);
    }),
  );
});

describe('vocabulary size', () => {
  const shard = (metadata: Record<string, unknown>, outputShape: number[] = [64, 7]): ParsedShard => ({
    metadata: { 'general.architecture': 'qwen35', ...metadata },
    tensorInfos: [{ name: 'output.weight', shape: Arr.map(outputShape, BigInt), dtype: 0, offset: 0n }],
    tensorDataOffset: 0n,
  });
  const vocab = (s: ParsedShard) =>
    parseModel({ path: '/m.gguf', shards: [s], fileSizes: [100], parameterCount: 0 }).vocabSize;

  it('<arch>.vocab_size when present', () =>
    assert.strictEqual(vocab(shard({ 'qwen35.vocab_size': 9, 'tokenizer.ggml.tokens': ['a', 'b'] })), 9));
  it("else the tokenizer's token list (llama.cpp's own source)", () =>
    assert.strictEqual(vocab(shard({ 'tokenizer.ggml.tokens': ['a', 'b', 'c', 'd', 'e'] })), 5));
  it("else the output tensor's second dimension", () => assert.strictEqual(vocab(shard({})), 7));
  it("else the embedding tensor's", () => {
    const s: ParsedShard = {
      ...shard({}),
      tensorInfos: [{ name: 'token_embd.weight', shape: [64n, 11n], dtype: 0, offset: 0n }],
    };
    assert.strictEqual(vocab(s), 11);
  });
});
