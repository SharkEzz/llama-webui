import { stat } from 'node:fs/promises';
import { GGMLFileQuantizationType, gguf, ggufAllShards, parseGgufShardFilename } from '@huggingface/gguf';
import { tensorBytes } from './sizes';

export interface TensorInfo {
  name: string;
  shape: number[];
  dtype: number;
  offset: number;
  bytes: number;
}

export interface ModelInfo {
  path: string;
  /** "mmproj" for a multimodal projector (general.type = mmproj or clip architecture). */
  kind: 'model' | 'mmproj';
  /** The header carries a chat template (tokenizer.chat_template). */
  hasChatTemplate: boolean;
  /** Every part of the model (one, or the shards in order). */
  files: string[];
  /** Sum of the parts' sizes. */
  fileBytes: number;
  arch: string;
  name: string;
  /** Label of general.file_type ("Q4_K_M", "IQ3_S"…), "?" when unknown. */
  quant: string;
  params: number;
  blockCount: number;
  embeddingLength: number;
  headCount: number;
  /** One value per layer (a scalar is repeated). */
  headCountKv: number[];
  keyLength: number;
  valueLength: number;
  contextLength: number;
  vocabSize: number;
  /** 0 when dense. */
  expertCount: number;
  expertUsedCount: number;
  fullAttentionInterval: number | null;
  slidingWindow: number | null;
  /** One full-attention layer every `swaPattern` layers when a sliding window is set; null when unknown. */
  swaPattern: number | null;
  nextnLayers: number;
  /** A `blk.*.ssm_*` or `*linear_attn*` tensor exists. */
  recurrent: boolean;
  /** 0 when not recurrent. */
  ssmStateBytesPerSeq: number;
  tensors: TensorInfo[];
}

export class ModelReadError extends Error {
  override name = 'ModelReadError';
}

type Metadata = Record<string, unknown>;

export interface ParsedShard {
  metadata: Metadata;
  tensorInfos: Array<{ name: string; shape: bigint[]; dtype: number; offset: bigint }>;
  tensorDataOffset: bigint;
}

const RECURRENT = /^blk\.\d+\.(ssm_|.*linear_attn)/;

function num(meta: Metadata, key: string, fallback: number): number {
  const v = meta[key];
  return typeof v === 'number' ? v : typeof v === 'bigint' ? Number(v) : fallback;
}

function numOrNull(meta: Metadata, key: string): number | null {
  const v = meta[key];
  return typeof v === 'number' ? v : typeof v === 'bigint' ? Number(v) : null;
}

/**
 * Many GGUFs (qwen35 among them) carry no `<arch>.vocab_size`: llama.cpp takes the tokenizer's token list,
 * else the output (or tied embedding) tensor's second dimension tells it.
 */
function vocabOf(meta: Metadata, arch: string, tensors: TensorInfo[]): number {
  const explicit = numOrNull(meta, `${arch}.vocab_size`);
  if (explicit !== null && explicit > 0) return explicit;
  const tokens = meta['tokenizer.ggml.tokens'];
  if (Array.isArray(tokens) && tokens.length > 0) return tokens.length;
  const t = tensors.find((x) => x.name === 'output.weight') ?? tensors.find((x) => x.name === 'token_embd.weight');
  return t?.shape[1] ?? 0;
}

/** Pure: assembles a ModelInfo from parsed shards (the first holds the metadata). */
export function parseModel(
  path: string,
  shards: ParsedShard[],
  fileSizes: number[],
  parameterCount: number,
): ModelInfo {
  const meta = shards[0]?.metadata ?? {};
  const arch = String(meta['general.architecture'] ?? '?');
  const k = (name: string) => `${arch}.${name}`;
  const tensors: TensorInfo[] = [];
  shards.forEach((s, i) => {
    const infos = [...s.tensorInfos].sort((a, b) => (a.offset < b.offset ? -1 : a.offset > b.offset ? 1 : 0));
    const bytes = tensorBytes(
      infos.map((t) => ({ offset: Number(t.offset) })),
      Number(s.tensorDataOffset),
      fileSizes[i] ?? 0,
    );
    for (const [j, t] of infos.entries())
      tensors.push({
        name: t.name,
        shape: t.shape.map(Number),
        dtype: t.dtype,
        offset: Number(t.offset),
        bytes: bytes[j]!,
      });
  });
  const blockCount = num(meta, k('block_count'), 0);
  const embeddingLength = num(meta, k('embedding_length'), 0);
  const headCount = num(meta, k('attention.head_count'), 1);
  const kvRaw = meta[k('attention.head_count_kv')];
  const headCountKv = Array.isArray(kvRaw)
    ? kvRaw.map(Number)
    : Array.from({ length: blockCount }, () =>
        typeof kvRaw === 'number' || typeof kvRaw === 'bigint' ? Number(kvRaw) : headCount,
      );
  const headDim = headCount > 0 ? Math.floor(embeddingLength / headCount) : 0;
  const ftype = numOrNull(meta, 'general.file_type');
  const quant = ftype !== null ? (GGMLFileQuantizationType[ftype] ?? '?') : '?';
  const recurrent = tensors.some((t) => RECURRENT.test(t.name));
  const inner = num(meta, k('ssm.inner_size'), 0);
  const state = num(meta, k('ssm.state_size'), 0);
  const conv = num(meta, k('ssm.conv_kernel'), 0);
  const fullAttentionInterval = numOrNull(meta, k('full_attention_interval'));
  const recurrentLayers = recurrent
    ? fullAttentionInterval
      ? blockCount - Math.floor(blockCount / fullAttentionInterval)
      : blockCount
    : 0;
  return {
    path,
    kind: meta['general.type'] === 'mmproj' || arch === 'clip' ? 'mmproj' : 'model',
    hasChatTemplate: typeof meta['tokenizer.chat_template'] === 'string',
    files: [],
    fileBytes: fileSizes.reduce((a, b) => a + b, 0),
    arch,
    name: String(meta['general.name'] ?? ''),
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
}

/** Parsed models by path, each with the stamp of every part; the oldest leaves past CACHE_MAX (a tensor table each). */
const cache = new Map<string, { stamp: string; info: ModelInfo }>();
const CACHE_MAX = 8;

async function sizeOf(path: string): Promise<{ mtimeMs: number; size: number }> {
  try {
    const s = await stat(path);
    return { mtimeMs: s.mtimeMs, size: s.size };
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') throw new ModelReadError(`file not found: ${path}`);
    if (code === 'EACCES' || code === 'EPERM') throw new ModelReadError(`permission denied: ${path}`);
    throw new ModelReadError(`${code ?? (e as Error).message}: ${path}`);
  }
}

/** Reads a GGUF (all shards when the name is `-00001-of-0000N.gguf`); cached by (path, mtime and size of every part). */
export async function readModel(path: string): Promise<ModelInfo> {
  const shard = parseGgufShardFilename(path);
  const files = shard
    ? Array.from(
        { length: Number(shard.total) },
        (_, i) => `${shard.prefix}-${String(i + 1).padStart(5, '0')}-of-${shard.total}.gguf`,
      )
    : [path];
  const stats = await Promise.all(files.map(sizeOf));
  const stamp = stats.map((s) => `${s.mtimeMs}:${s.size}`).join('|');
  const hit = cache.get(path);
  if (hit && hit.stamp === stamp) return hit.info;
  const sizes = stats.map((s) => s.size);
  let shards: ParsedShard[];
  let parameterCount: number;
  try {
    if (shard) {
      const all = await ggufAllShards(path, { allowLocalFile: true });
      shards = all.shards as unknown as ParsedShard[];
      parameterCount = all.parameterCount;
    } else {
      const one = await gguf(path, { allowLocalFile: true, computeParametersCount: true });
      shards = [one as unknown as ParsedShard];
      parameterCount = one.parameterCount;
    }
  } catch (e) {
    throw new ModelReadError(`unreadable GGUF: ${(e as Error).message}`);
  }
  const info = { ...parseModel(path, shards, sizes, parameterCount), files };
  cache.delete(path);
  cache.set(path, { stamp, info });
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value as string);
  return info;
}
