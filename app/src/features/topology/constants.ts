import type { TopologyNode, TopologyNodeKind } from '@llama-webui/shared';
import type { Tone } from '@/components/glass/tones';
import type { LayerKind, NodeLive } from './flows';
import { LAYER_TINT, tint } from './themeColors';

export const NEUTRAL = 'var(--muted-foreground)';

/** A block's kind, in words. */
export const KIND_LABEL = {
  cpu: 'Processor',
  ram: 'Memory',
  gpu: 'GPU',
  nvme: 'NVMe drive',
  chipset: 'Chipset',
} as const satisfies Record<TopologyNodeKind, string>;

/** A block's color: a GPU's data tone, or the one of its kind. */
export type BlockTone = Tone | 'indigo' | 'primary' | 'neutral';

const TONE_CSS = {
  blue: 'var(--tone-blue)',
  teal: 'var(--tone-teal)',
  amber: 'var(--tone-amber)',
  rose: 'var(--tone-rose)',
  indigo: 'var(--tone-indigo)',
  primary: 'var(--primary-ink)',
  neutral: 'var(--muted-foreground)',
} as const satisfies Record<BlockTone, string>;

export const toneVar = (tone: BlockTone) => TONE_CSS[tone];

export function toneOfNode(node: TopologyNode, tones: Map<string, Tone>): BlockTone {
  if (node.kind === 'gpu') return tones.get(node.id) ?? 'neutral';
  return node.kind === 'cpu' ? 'primary' : node.kind === 'ram' ? 'indigo' : 'neutral';
}

/** A fact of the block by its label (the temperature, the power…); null when the sample does not have it. */
export const factOf = (live: NodeLive, label: string) => live.facts.find((f) => f.label === label)?.value ?? null;

/** Color of a memory layer for use outside a block (tooltips, swatches), matching `Layers`. */
export function layerSwatchColor(kind: LayerKind, tone: BlockTone, neutral = false): string {
  if (kind === 'other' || (neutral && kind === 'used')) return NEUTRAL;
  const base = toneVar(tone);
  if (kind === 'kv') return tint(base, LAYER_TINT.kv);
  if (kind === 'compute') return tint(base, LAYER_TINT.compute);
  return base;
}
