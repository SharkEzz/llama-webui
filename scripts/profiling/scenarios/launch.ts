// launch: the profile started with the Dashboard open, until llama-server is ready, plus its first snapshots.
import { openPage } from '../browser.ts';
import { sleep } from '../instance.ts';
import { measure, type Scenario } from '../measure.ts';

export const launch: Scenario<'launch'> = {
  name: 'launch',
  run: async (ctx) => {
    const page = await openPage(ctx, '/');
    let ready = { readyMs: 0, logLines: 0 };
    const window = await measure(ctx, page, {
      id: 'launch',
      label: 'Profile start, Dashboard open',
      ms: 5000,
      profile: true,
      ws: true,
      during: async () => {
        ready = await ctx.instance.startProfile();
        // The first snapshots with a model, and the placement, still belong to the launch.
        await sleep(3000);
      },
    });
    ctx.log(`ready in ${(ready.readyMs / 1000).toFixed(1)} s, ${String(ready.logLines)} log lines`);
    return { ...ready, windows: [window] };
  },
};
