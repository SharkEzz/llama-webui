// tps: llama-server's own throughput on a fixed request and seed, with no page open, the Dashboard, and a static page;
// the modes interleaved, six runs each, after one warm-up request.
import { closePages, openPage } from '../browser.ts';
import { sleep } from '../instance.ts';
import { isRecord, num } from '../json.ts';
import type { Scenario } from '../measure.ts';
import type { TpsMode } from '../results.ts';

const REQUEST = {
  prompt: 'Write a long, detailed essay about the history of the printing press.\n\n',
  n_predict: 300,
  seed: 42,
  temperature: 0,
  cache_prompt: false,
};
const MODES: TpsMode[] = ['no-page', 'dashboard', 'static-page'];

export const tps: Scenario<'tps'> = {
  name: 'tps',
  run: async (ctx) => {
    const url = `${await ctx.instance.llamaUrl()}/completion`;
    const one = async (): Promise<number> => {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(REQUEST),
        signal: AbortSignal.timeout(120_000),
      });
      const body: unknown = await res.json();
      if (!res.ok || !isRecord(body) || !isRecord(body.timings))
        throw new Error(`POST /completion: ${String(res.status)}, no timings in the response`);
      return num(body.timings.predicted_per_second);
    };
    await one();
    const runs = new Map<TpsMode, number[]>(MODES.map((m) => [m, []]));
    for (let round = 1; round <= 3; round++)
      for (const mode of MODES) {
        if (mode === 'no-page') await closePages(ctx);
        else await openPage(ctx, mode === 'dashboard' ? '/' : '/settings');
        await sleep(3000);
        for (let i = 0; i < 2; i++) {
          const t = await one();
          runs.get(mode)?.push(t);
          ctx.log(`${mode} #${String(round)}.${String(i + 1)}: ${t.toFixed(2)} tok/s`);
        }
      }
    return { modes: MODES.map((id) => ({ id, tokensPerSec: runs.get(id) ?? [] })) };
  },
};
