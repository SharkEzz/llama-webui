/*
 * Colors of the drawing. They are the theme's tokens, used as CSS wherever CSS reads them; only the canvas of the
 * streaks needs them resolved.
 */

/**
 * Share of white mixed into a GPU's tone for each layer of its memory: the model keeps the full tone, its KV cache and
 * its compute buffers are lighter shades of it. Shared by the blocks and the legend's swatches.
 */
export const LAYER_TINT = { model: 0, kv: 0.18, compute: 0.42 } as const;

/** A lighter shade of a color (mixed in linear space, where a little white goes a long way). */
export const tint = (color: string, k: number) =>
  k > 0 ? `color-mix(in srgb-linear, ${color}, white ${Math.round(k * 100)}%)` : color;

const resolved = new Map<string, string>();

/**
 * A CSS color (a token, a `color-mix()`) as the browser computes it, for a canvas, which does not read custom
 * properties. `theme` is the theme the value is asked for: the same token is another color in the other one.
 */
export function resolveColor(css: string, theme: string): string {
  const key = `${theme}\n${css}`;
  const known = resolved.get(key);
  if (known !== undefined) return known;
  const probe = document.createElement('span');
  probe.style.color = css;
  document.body.append(probe);
  const value = getComputedStyle(probe).color;
  probe.remove();
  resolved.set(key, value);
  return value;
}
