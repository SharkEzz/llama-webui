// api: every GET the pages make, fetched once (the first call opens the connection and warms the handler), then 20
// times: median, 95th percentile, size. The URLs come from the `pages` result of the same run, else from a visit of
// each page.
import { loadAndKeep, closePage } from '../browser.ts';
import { now } from '../instance.ts';
import type { Scenario } from '../measure.ts';
import type { ScenarioResults } from '../results.ts';
import { PAGE_PATHS } from './pages.ts';

const REPEATS = 20;

/** Streams never end and Hub calls leave the machine: neither is replayed. */
const replayable = (url: string) => !url.includes('/stream') && !url.startsWith('/api/hf');

export const api: Scenario<'api'> = {
  name: 'api',
  run: async (ctx) => {
    const urls = new Set<string>();
    const pages = ctx.run.exists() ? ctx.run.readResults().scenarios.pages : undefined;
    if (pages) for (const p of pages.pages) for (const c of p.apiCalls) urls.add(c.url);
    else
      for (const path of PAGE_PATHS) {
        const { page, apiCalls } = await loadAndKeep(ctx, path, 'cold');
        await closePage(page);
        for (const c of apiCalls) urls.add(c.url);
      }
    const fetchOnce = async (url: string) => {
      const t0 = now();
      const res = await fetch(`${ctx.instance.baseUrl}${url}`, { signal: AbortSignal.timeout(30_000) });
      const bytes = (await res.arrayBuffer()).byteLength;
      if (!res.ok) throw new Error(`GET ${url}: ${String(res.status)}`);
      return { ms: now() - t0, bytes };
    };
    const routes: ScenarioResults['api']['routes'] = [];
    for (const url of [...urls].filter(replayable).toSorted()) {
      const first = await fetchOnce(url);
      const runs: number[] = [];
      let bytes = first.bytes;
      for (let i = 0; i < REPEATS; i++) {
        const r = await fetchOnce(url);
        runs.push(r.ms);
        bytes = r.bytes;
      }
      const times = runs.toSorted((a, b) => a - b);
      const q = (p: number) => times[Math.min(times.length - 1, Math.floor(p * times.length))] ?? 0;
      routes.push({ url, firstMs: first.ms, p50Ms: q(0.5), p95Ms: q(0.95), bytes });
      ctx.log(`${url}: p50 ${q(0.5).toFixed(1)} ms, p95 ${q(0.95).toFixed(1)} ms, ${String(bytes)} B`);
    }
    return { routes };
  },
};
