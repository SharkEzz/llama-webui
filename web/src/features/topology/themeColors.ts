import { useMemo } from 'react';
import { Color } from 'three';
import type { Tone } from '@/components/glass/tones';
import { useTheme } from '@/lib/theme';

export interface SceneColors {
  dark: boolean;
  tone: Record<Tone, Color>;
  primary: Color;
  /** Neutral glow of components without a tone (RAM, NVMe, chipset). */
  neutral: Color;
  /** Body of the blocks and tubes. */
  slab: Color;
  tube: Color;
}

/** Any CSS color (including `oklch()`, which Three cannot read) → `#rrggbb`, via the browser's 2D canvas. */
export function cssToHex(value: string): string | null {
  const canvas = document.createElement('canvas');
  canvas.width = 1;
  canvas.height = 1;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.fillStyle = '#000000';
  ctx.fillStyle = value;
  ctx.fillRect(0, 0, 1, 1);
  const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
  return `#${[r, g, b].map((v) => (v ?? 0).toString(16).padStart(2, '0')).join('')}`;
}

/** Value of a theme color token, resolved by the browser on the root element. */
export function cssVarColor(name: string, fallback: string): Color {
  const probe = document.createElement('span');
  probe.style.color = `var(${name})`;
  document.body.appendChild(probe);
  const resolved = getComputedStyle(probe).color;
  probe.remove();
  return new Color(cssToHex(resolved) ?? fallback);
}

/** Scene colors, recomputed when the theme changes. */
export function useSceneColors(): SceneColors {
  const resolved = useTheme((s) => s.resolved);
  return useMemo(() => {
    const dark = resolved === 'dark';
    return {
      dark,
      tone: {
        blue: cssVarColor('--tone-blue', '#4f8cff'),
        teal: cssVarColor('--tone-teal', '#3fc1b0'),
        amber: cssVarColor('--tone-amber', '#e0a53a'),
        rose: cssVarColor('--tone-rose', '#e8617a'),
      },
      primary: cssVarColor('--primary', '#4f8cff'),
      neutral: cssVarColor('--foreground', dark ? '#f2f3f5' : '#2a2d33'),
      slab: new Color(dark ? '#23262d' : '#dfe3ea'),
      tube: new Color(dark ? '#3a3f4a' : '#b8bfca'),
    };
  }, [resolved]);
}
