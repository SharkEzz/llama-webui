// launch: the profile started with the Dashboard open, until llama-server is ready, plus its first snapshots.
import { openPage } from '../browser.ts';
import { sleep } from '../instance.ts';
import { measure, type Scenario } from '../measure.ts';
import { evict, profileFiles, residentPct } from '../pagecache.ts';
import { REPO } from '../target.ts';

export const launch: Scenario<'launch'> = {
  name: 'launch',
  run: async (ctx) => {
    // From the disk, as a first start after a reboot: a model left in the page cache by a previous pass starts in a
    // fraction of the time.
    const profile =
      ctx.options.profile === null ? null : await ctx.instance.api(`/api/profiles/${String(ctx.options.profile)}`);
    const files = profileFiles(profile, REPO);
    if (!evict(files)) ctx.log('warning: could not evict the model from the page cache');
    const modelCachedPct = residentPct(files);
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
    const cached = modelCachedPct === null ? 'unknown' : `${modelCachedPct.toFixed(0)} %`;
    ctx.log(
      `ready in ${(ready.readyMs / 1000).toFixed(1)} s, ${String(ready.logLines)} log lines, model in the page cache at the start: ${cached} of ${String(files.length)} files`,
    );
    return { ...ready, modelCachedPct, windows: [window] };
  },
};
