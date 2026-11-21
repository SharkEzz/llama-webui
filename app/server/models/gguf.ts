import { GGMLFileQuantizationType, parseGgufShardFilename } from '@huggingface/gguf';
import { Array as Arr, Number as Num, Option, Order, Predicate, Schema, String as Str } from 'effect';
import { tensorBytes } from './sizes.ts';

export interface TensorInfo {
  readonly name: string;
  readonly shape: ReadonlyArray<number>;
  readonly dtype: number;
  readonly offset: number;
  readonly bytes: number;
}

export interface ModelInfo {
  readonly path: string;
  /** "mmproj" for a multimodal projector (general.type = mmproj or clip architecture). */
  readonly kind: 'model' | 'mmproj';
  /** The header carries a chat template (tokenizer.chat_template). */
  readonly hasChatTemplate: boolean;
  /** Every part of the model (one, or the shards in order). */
  readonly files: ReadonlyArray<string>;
  /** Sum of the parts' sizes. */
  readonly fileBytes: number;
  readonly arch: string;
  readonly name: string;
  /** Label of general.file_type ("Q4_K_M", "IQ3_S"…), "?" when unknown. */
  readonly quant: string;
  readonly params: number;
  readonly blockCount: number;
  readonly embeddingLength: number;
  readonly headCount: number;
  /** One value per layer (a scalar is repeated). */
  readonly headCountKv: ReadonlyArray<number>;
  readonly keyLength: number;
  readonly valueLength: number;
  readonly contextLength: number;
  readonly vocabSize: number;
  /** 0 when dense. */
  readonly expertCount: number;
  readonly expertUsedCount: number;
  readonly fullAttentionInterval: number | null;
  readonly slidingWindow: number | null;
  /** One full-attention layer every `swaPattern` layers when a sliding window is set; null when unknown. */
  readonly swaPattern: number | null;
  readonly nextnLayers: number;
  /** A `blk.*.ssm_*` or `*linear_attn*` tensor exists. */
  readonly recurrent: boolean;
  /** 0 when not recurrent. */
  readonly ssmStateBytesPerSeq: number;
  readonly tensors: ReadonlyArray<TensorInfo>;
}

/** Why a GGUF could not be read: `file not found: <path>`, `permission denied: <path>`, `unreadable GGUF: …`. */
export class ModelReadError extends Schema.TaggedError<ModelReadError, { readonly ModelReadError: unique symbol }>()(
  'ModelReadError',
  { message: Schema.String },
) {}

/** The header of a part, read key by key (`field`). */
type Metadata = object;

/** The value of `key` in the header, `undefined` when absent. */
const field = (meta: Metadata, key: string): unknown => (Predicate.hasProperty(meta, key) ? meta[key] : undefined);

/** What `@huggingface/gguf` parsed of one part. */
export interface ParsedShard {
  readonly metadata: Metadata;
  readonly tensorInfos: ReadonlyArray<{
    readonly name: string;
    readonly shape: ReadonlyArray<bigint>;
    readonly dtype: number;
    readonly offset: bigint;
  }>;
  readonly tensorDataOffset: bigint;
}

/** `f` of 0 to `n - 1` (none when `n` is below 1, unlike `Arr.makeBy`). */
const times = <A>(n: number, f: (i: number) => A): Array<A> => (n >= 1 ? Arr.makeBy(n, f) : []);

const RECURRENT = /^blk\.\d+\.(ssm_|.*linear_attn)/;

/** A number or a bigint of the metadata, as a number. */
const numberOf = (v: unknown): Option.Option<number> =>
  Predicate.isNumber(v) ? Option.some(v) : Predicate.isBigInt(v) ? Option.some(Number(v)) : Option.none();

const num = (meta: Metadata, key: string, fallback: number): number =>
  Option.getOrElse(numberOf(field(meta, key)), () => fallback);

const numOrNull = (meta: Metadata, key: string): number | null => Option.getOrNull(numberOf(field(meta, key)));

/**
 * Many GGUFs (qwen35 among them) carry no `<arch>.vocab_size`: llama.cpp takes the tokenizer's token list,
 * else the output (or tied embedding) tensor's second dimension tells it.
 */
const vocabOf = (meta: Metadata, arch: string, tensors: ReadonlyArray<TensorInfo>): number => {
  const explicit = numOrNull(meta, `${arch}.vocab_size`);
  if (explicit !== null && explicit > 0) return explicit;
  const tokens = field(meta, 'tokenizer.ggml.tokens');
  if (Arr.isArray(tokens) && Arr.isReadonlyArrayNonEmpty(tokens)) return tokens.length;
  const named = (name: string) => Arr.findFirst(tensors, (x) => x.name === name);
  return Option.orElse(named('output.weight'), () => named('token_embd.weight')).pipe(
    Option.flatMap((t) => Arr.get(t.shape, 1)),
    Option.getOrElse(() => 0),
  );
};

const byOffset = Order.mapInput(Order.BigInt, (t: ParsedShard['tensorInfos'][number]) => t.offset);

/** What a model is assembled from. */
export interface ParseModelOptions {
  readonly path: string;
  /** The parts in order; the first holds the metadata. */
  readonly shards: ReadonlyArray<ParsedShard>;
  /** The size of each part, in the same order. */
  readonly fileSizes: ReadonlyArray<number>;
  readonly parameterCount: number;
}

/** Pure: assembles a model from its parsed parts and the parts' sizes. */
export const parseModel = ({
  path,
  shards,
  fileSizes,
  parameterCount,
}: ParseModelOptions): Omit<ModelInfo, 'files'> => {
  const meta: Metadata = Option.match(Arr.head(shards), { onNone: () => ({}), onSome: (s) => s.metadata });
  const arch = String(field(meta, 'general.architecture') ?? '?');
  const k = (name: string) => `${arch}.${name}`;
  const tensors = Arr.flatten(
    Arr.map(shards, (s, i) => {
      const infos = Arr.sort(s.tensorInfos, byOffset);
      const bytes = tensorBytes(
        Arr.map(infos, (t) => ({ offset: Number(t.offset) })),
        Number(s.tensorDataOffset),
        Option.getOrElse(Arr.get(fileSizes, i), () => 0),
      );
      return Arr.map(
        infos,
        (t, j): TensorInfo => ({
          name: t.name,
          shape: Arr.map(t.shape, Number),
          dtype: t.dtype,
          offset: Number(t.offset),
          bytes: bytes[j]!,
        }),
      );
    }),
  );
  const blockCount = num(meta, k('block_count'), 0);
  const embeddingLength = num(meta, k('embedding_length'), 0);
  const headCount = num(meta, k('attention.head_count'), 1);
  const kvRaw = field(meta, k('attention.head_count_kv'));
  const headCountKv = Arr.isArray(kvRaw)
    ? Arr.map(kvRaw, Number)
    : times(blockCount, () => Option.getOrElse(numberOf(kvRaw), () => headCount));
  const headDim = headCount > 0 ? Math.floor(embeddingLength / headCount) : 0;
  const ftype = numOrNull(meta, 'general.file_type');
  const quant = ftype !== null ? (GGMLFileQuantizationType[ftype] ?? '?') : '?';
  const recurrent = Arr.some(tensors, (t) => RECURRENT.test(t.name));
  const inner = num(meta, k('ssm.inner_size'), 0);
  const state = num(meta, k('ssm.state_size'), 0);
  const conv = num(meta, k('ssm.conv_kernel'), 0);
  const fullAttentionInterval = numOrNull(meta, k('full_attention_interval'));
  const recurrentLayers = recurrent
    ? fullAttentionInterval !== null && fullAttentionInterval !== 0
      ? blockCount - Math.floor(blockCount / fullAttentionInterval)
      : blockCount
    : 0;
  return {
    path,
    kind: field(meta, 'general.type') === 'mmproj' || arch === 'clip' ? 'mmproj' : 'model',
    hasChatTemplate: Predicate.isString(field(meta, 'tokenizer.chat_template')),
    fileBytes: Num.sumAll(fileSizes),
    arch,
    name: String(field(meta, 'general.name') ?? ''),
    quant,
    params: parameterCount,
    blockCount,
    embeddingLength,
    headCount,
    headCountKv,
    keyLength: num(meta, k('attention.key_length'), headDim),
    valueLength: num(meta, k('attention.value_length'), headDim),
    contextLength: num(meta, k('context_length'), 0),
    vocabSize: vocabOf(meta, arch, tensors),
    expertCount: num(meta, k('expert_count'), 0),
    expertUsedCount: num(meta, k('expert_used_count'), 0),
    fullAttentionInterval,
    slidingWindow: numOrNull(meta, k('attention.sliding_window')),
    swaPattern: numOrNull(meta, k('attention.sliding_window_pattern')),
    nextnLayers: num(meta, k('nextn_predict_layers'), 0),
    recurrent,
    ssmStateBytesPerSeq: recurrent ? recurrentLayers * (inner * state + conv * inner) * 4 : 0,
    tensors,
  };
};

/** Every part of a model: the `-0000k-of-0000N.gguf` names of a split one, in order, else the path alone. */
export const shardFiles = (path: string): ReadonlyArray<string> => {
  const shard = parseGgufShardFilename(path);
  if (shard === null) return [path];
  return times(
    Number(shard.total),
    (i) => `${shard.prefix}-${Str.padStart(5, '0')(String(i + 1))}-of-${shard.total}.gguf`,
  );
};
