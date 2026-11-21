import type { Measure } from '@llama-webui/shared';
import { Array as Arr } from 'effect';

/** The mean and the population standard deviation of `values` (none: 0), over `tokens` tokens. */
export const measure = (sample: { readonly values: ReadonlyArray<number>; readonly tokens: number }): Measure => {
  const count = Math.max(1, sample.values.length);
  const mean = Arr.reduce(sample.values, 0, (sum, v) => sum + v) / count;
  const variance = Arr.reduce(sample.values, 0, (sum, v) => sum + (v - mean) ** 2) / count;
  return { tps: mean, stddev: Math.sqrt(variance), tokens: sample.tokens };
};

/** The share of the drafted tokens accepted, in percent rounded to 0.1; none drafted: null. */
export const draftAcceptPct = (drafts: { readonly drafted: number; readonly accepted: number }): number | null =>
  drafts.drafted > 0 ? Math.round((drafts.accepted / drafts.drafted) * 1000) / 10 : null;
