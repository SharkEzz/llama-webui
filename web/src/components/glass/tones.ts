export type Tone = "violet" | "cyan" | "amber" | "rose";

export const TONE_VAR: Record<Tone, string> = {
  violet: "var(--tone-violet)",
  cyan: "var(--tone-cyan)",
  amber: "var(--tone-amber)",
  rose: "var(--tone-rose)",
};
