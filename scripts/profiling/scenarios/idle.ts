// idle: the server and its NVML sampler with no page and no model: a clean window, then a profiled one.
import { measure, type Scenario } from '../measure.ts';

export const idle: Scenario<'idle'> = {
  name: 'idle',
  run: async (ctx) => ({
    windows: [
      await measure(ctx, null, { id: 'clean', label: 'No page, clean', ms: 30_000 }),
      await measure(ctx, null, { id: 'profiled', label: 'No page, profiled', ms: 20_000, profile: true }),
    ],
  }),
};
