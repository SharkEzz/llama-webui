import { type BenchDevice, type CacheType, MiB } from '@llama-webui/shared';
import { dual } from 'effect/Function';
import type { ModelInfo } from '../models/gguf.ts';

/** Bytes per KV cache element. */
export const KV_BYTES: Readonly<Record<CacheType, number>> = {
  f32: 4,
  f16: 2,
  bf16: 2,
  q8_0: 1.0625,
  f8_e4m3: 1,
  q5_1: 0.75,
  q5_0: 0.6875,
  q4_1: 0.625,
  q4_0: 0.5625,
  iq4_nl: 0.5625,
};

/** The K and V cache types of a configuration. */
export interface KvTypes {
  readonly k: CacheType;
  readonly v: CacheType;
}

/** Architectures whose sliding-window pattern is not written in the GGUF. */
const SWA_PATTERN_DEFAULT: Readonly<Record<string, number>> = { 'gpt-oss': 2 };

const swaPattern = (m: ModelInfo): number => m.swaPattern ?? SWA_PATTERN_DEFAULT[m.arch] ?? 6;

/** The interval of full-attention layers, when the model has one (0 counts as none). */
const fullAttention = (m: ModelInfo): number | null =>
  m.fullAttentionInterval === null || m.fullAttentionInterval === 0 ? null : m.fullAttentionInterval;

/** Layer `i` has a KV cache: not an MTP layer, not a recurrent layer (copied from llama-tui). */
export const holdsKv: {
  (i: number): (m: ModelInfo) => boolean;
  (m: ModelInfo, i: number): boolean;
} = dual(2, (m: ModelInfo, i: number): boolean => {
  if (i >= m.blockCount - m.nextnLayers) return false;
  const interval = fullAttention(m);
  if (m.recurrent && interval === null) return false;
  if (interval !== null && i % interval !== interval - 1) return false;
  return true;
});

/** What one layer's KV cache is measured at: its index, the context, the cache types. */
export interface KvLayer {
  readonly layer: number;
  readonly ctx: number;
  readonly kv: KvTypes;
}

/** KV cache bytes of a layer at `ctx` tokens (K and V may differ in type); 0 without a cache. */
export const kvLayerBytes: {
  (layer: KvLayer): (m: ModelInfo) => number;
  (m: ModelInfo, layer: KvLayer): number;
} = dual(2, (m: ModelInfo, { layer: i, ctx, kv }: KvLayer): number => {
  if (!holdsKv(m, i)) return 0;
  const pattern = swaPattern(m);
  const heads = m.headCountKv[i] ?? m.headCountKv[0] ?? m.headCount;
  const tokens = m.slidingWindow !== null && i % pattern !== pattern - 1 ? Math.min(ctx, m.slidingWindow) : ctx;
  return heads * (m.keyLength * KV_BYTES[kv.k] + m.valueLength * KV_BYTES[kv.v]) * tokens;
});

/** Recurrent state per sequence, independent of the context. */
export const recurrentBytes = (m: ModelInfo): number => m.ssmStateBytesPerSeq;

/** Compute buffers of the main GPU for a micro-batch of `ub` tokens. */
export const computeBytes: {
  (ub: number): (m: ModelInfo) => number;
  (m: ModelInfo, ub: number): number;
} = dual(2, (m: ModelInfo, ub: number): number => ub * (m.embeddingLength * 4 + m.vocabSize * 4) + 256 * MiB);

/** VRAM kept free on a card: CUDA/Vulkan context, fragmentation. */
export const marginBytes = (totalBytes: number): number => 512 * MiB + 0.04 * totalBytes;

/** What the estimator may fill on a device: total, minus the margin, minus the VRAM other processes hold (#26). */
export const budgetBytes = (d: BenchDevice): number => {
  const total = d.totalMib * MiB;
  return Math.max(0, total - marginBytes(total) - (d.otherUsedMib ?? 0) * MiB);
};
