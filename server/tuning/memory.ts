import type { CacheType } from '@llama-webui/shared';
import type { ModelInfo } from '../models/gguf';

/** Octets par élément du cache KV. */
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

/** Architectures dont le motif de fenêtre glissante n'est pas écrit dans le GGUF. */
const SWA_PATTERN_DEFAULT: Record<string, number> = { 'gpt-oss': 2 };

const swaPattern = (m: ModelInfo) => m.swaPattern ?? SWA_PATTERN_DEFAULT[m.arch] ?? 6;

/** La couche `i` a un cache KV : pas une couche MTP, pas une couche récurrente (copié de llama-tui). */
export function holdsKv(m: ModelInfo, i: number): boolean {
  if (i >= m.blockCount - m.nextnLayers) return false;
  if (m.recurrent && !m.fullAttentionInterval) return false;
  if (m.fullAttentionInterval && i % m.fullAttentionInterval !== m.fullAttentionInterval - 1) return false;
  return true;
}

/** Octets du cache KV de la couche `i` à `ctx` jetons (K et V de types éventuellement différents) ; 0 sans cache. */
export function kvLayerBytes(m: ModelInfo, i: number, ctx: number, kv: { k: CacheType; v: CacheType }): number {
  if (!holdsKv(m, i)) return 0;
  const pattern = swaPattern(m);
  const heads = m.headCountKv[i] ?? m.headCountKv[0] ?? m.headCount;
  const swa = m.slidingWindow !== null && i % pattern !== pattern - 1;
  const tokens = swa ? Math.min(ctx, m.slidingWindow as number) : ctx;
  return heads * (m.keyLength * KV_BYTES[kv.k] + m.valueLength * KV_BYTES[kv.v]) * tokens;
}

/** État récurrent par séquence, indépendant du contexte. */
export const recurrentBytes = (m: ModelInfo): number => m.ssmStateBytesPerSeq;

/** Tampons de calcul du GPU principal pour un micro-batch de `ub` jetons. */
export const computeBytes = (m: ModelInfo, ub: number): number =>
  ub * (m.embeddingLength * 4 + m.vocabSize * 4) + 256 * MiB;

/** VRAM gardée libre sur une carte : contexte CUDA/Vulkan, fragmentation. */
export const marginBytes = (totalBytes: number): number => 512 * MiB + 0.04 * totalBytes;

export function fmtBytes(n: number): string {
  if (n >= GiB) return `${(n / GiB).toFixed(1).replace('.', ',')} Gio`;
  return `${Math.round(n / MiB)} Mio`;
}
