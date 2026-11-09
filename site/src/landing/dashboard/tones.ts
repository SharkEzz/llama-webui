// Same tones as web/src/components/glass/tones.ts.
export type Tone = 'blue' | 'teal' | 'amber' | 'rose';

export const TONE_VAR: Record<Tone, string> = {
  blue: 'var(--tone-blue)',
  teal: 'var(--tone-teal)',
  amber: 'var(--tone-amber)',
  rose: 'var(--tone-rose)',
};
