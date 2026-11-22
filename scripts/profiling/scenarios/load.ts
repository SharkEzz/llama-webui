// load: the Dashboard loaded three times with a cold cache (a new browser context each), then three warm reloads.
import { loadPage } from '../browser.ts';
import type { Scenario } from '../measure.ts';
import type { PageLoad } from '../results.ts';

export const load: Scenario<'load'> = {
  name: 'load',
  run: async (ctx) => {
    const loads: PageLoad[] = [];
    for (const cache of ['cold', 'cold', 'cold', 'warm', 'warm', 'warm'] as const) {
      const l = await loadPage(ctx, '/', cache);
      loads.push(l);
      ctx.log(
        `${cache}: TTFB ${l.ttfbMs.toFixed(0)} ms, FCP ${l.fcpMs.toFixed(0)} ms, LCP ${l.lcpMs.toFixed(0)} ms, ${String(l.requests)} requests, ${(l.wireBytes / 1024).toFixed(0)} KiB on the wire`,
      );
    }
    return { loads };
  },
};
