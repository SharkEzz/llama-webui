// pages: every page of the app loaded cold in a new browser context (its load, its API calls), then 12 s of presence.
import { closePage, loadAndKeep } from '../browser.ts';
import { measure, type Scenario } from '../measure.ts';
import type { ScenarioResults } from '../results.ts';

export const PAGE_PATHS = [
  '/',
  '/server',
  '/system',
  '/topology',
  '/logs',
  '/models',
  '/profiles',
  '/chat',
  '/bench',
  '/tuning',
  '/settings',
];

export const pages: Scenario<'pages'> = {
  name: 'pages',
  run: async (ctx) => {
    const out: ScenarioResults['pages']['pages'] = [];
    for (const path of PAGE_PATHS) {
      const { load, page, apiCalls } = await loadAndKeep(ctx, path, 'cold');
      const window = await measure(ctx, page, { id: path, label: path, ms: 12_000 });
      await closePage(page);
      out.push({ path, load, window, apiCalls });
      ctx.log(
        `${path}: LCP ${load.lcpMs.toFixed(0)} ms, script ${load.scriptMs.toFixed(0)} ms, ${String(apiCalls.length)} API calls, chrome-renderer ${(window.procs.cpuPct['chrome-renderer'] ?? 0).toFixed(1)} %`,
      );
    }
    return { pages: out };
  },
};
