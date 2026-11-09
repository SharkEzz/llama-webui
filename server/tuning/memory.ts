import type { BenchDevice, CacheType } from '@llama-webui/shared';
import type { ModelInfo } from '../models/gguf';

/** Bytes per KV cache element. */
export const KV_BYTES: Record<CacheType, number> = {
  f32: 4,
  f16: 2,
  bf16: 2,
  q8_0: 1.0625,
  q5_1: 0.75,
  q5_0: 0.6875,
  q4_1: 0.625,
  q4_0: 0.5625,
  iq4_nl: 0.5625,
};

export const MiB = 1024 ** 2;
export const GiB = 1024 ** 3;

/** Architectures whose sliding-window pattern is not written in the GGUF. */
const SWA_PATTERN_DEFAULT: Record<string, number> = { 'gpt-oss': 2 };

const swaPattern = (m: ModelInfo) => m.swaPattern ?? SWA_PATTERN_DEFAULT[m.arch] ?? 6;

/** Layer `i` has a KV cache: not an MTP layer, not a recurrent layer (copied from llama-tui). */
export function holdsKv(m: ModelInfo, i: number): boolean {
  if (i >= m.blockCount - m.nextnLayers) return false;
  if (m.recurrent && !m.fullAttentionInterval) return false;
  if (m.fullAttentionInterval && i % m.fullAttentionInterval !== m.fullAttentionInterval - 1) return false;
  return true;
}

/** KV cache bytes of layer `i` at `ctx` tokens (K and V may differ in type); 0 without a cache. */
export function kvLayerBytes(m: ModelInfo, i: number, ctx: number, kv: { k: CacheType; v: CacheType }): number {
  if (!holdsKv(m, i)) return 0;
  const pattern = swaPattern(m);
  const heads = m.headCountKv[i] ?? m.headCountKv[0] ?? m.headCount;
  const swa = m.slidingWindow !== null && i % pattern !== pattern - 1;
  const tokens = swa ? Math.min(ctx, m.slidingWindow as number) : ctx;
  return heads * (m.keyLength * KV_BYTES[kv.k] + m.valueLength * KV_BYTES[kv.v]) * tokens;
}

/** Recurrent state per sequence, independent of the context. */
export const recurrentBytes = (m: ModelInfo): number => m.ssmStateBytesPerSeq;

/** Compute buffers of the main GPU for a micro-batch of `ub` tokens. */
export const computeBytes = (m: ModelInfo, ub: number): number =>
  ub * (m.embeddingLength * 4 + m.vocabSize * 4) + 256 * MiB;

/** VRAM kept free on a card: CUDA/Vulkan context, fragmentation. */
export const marginBytes = (totalBytes: number): number => 512 * MiB + 0.04 * totalBytes;

/** What the estimator may fill on a device: total, minus the margin, minus the VRAM other processes hold (#26). */
export function budgetBytes(d: BenchDevice): number {
  const total = d.totalMib * MiB;
  return Math.max(0, total - marginBytes(total) - (d.otherUsedMib ?? 0) * MiB);
}

export function fmtBytes(n: number): string {
  if (n >= GiB) return `${(n / GiB).toFixed(1)} GiB`;
  return `${Math.round(n / MiB)} MiB`;
}
