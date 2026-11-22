// dashboard: the Dashboard at rest with a model loaded: a clean window, a profiled one with its census, a trace.
import { census, openPage } from '../browser.ts';
import { measure, type Scenario } from '../measure.ts';

export const dashboard: Scenario<'dashboard'> = {
  name: 'dashboard',
  run: async (ctx) => {
    const page = await openPage(ctx, '/');
    const clean = await measure(ctx, page, { id: 'clean', label: 'Dashboard, clean', ms: 60_000, ws: true });
    const profiled = await measure(ctx, page, {
      id: 'profiled',
      label: 'Dashboard, profiled',
      ms: 60_000,
      profile: true,
    });
    profiled.census = await census(ctx, page, 10_000);
    const trace = await measure(ctx, page, { id: 'trace', label: 'Dashboard, traced', ms: 20_000, trace: true });
    return { windows: [clean, profiled, trace] };
  },
};
