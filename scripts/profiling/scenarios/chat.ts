// chat: the Chat page streaming one long Markdown reply, typed in its composer: three successive windows over the same
// reply as its text grows (trace, clean, profiled, then a census), then the reply's own figures once it has ended.
import type { Page } from 'puppeteer-core';
import { census, openPage } from '../browser.ts';
import { lastReply, LONG_PROMPT, temporaryConversation } from '../chat-api.ts';
import { now, sleep } from '../instance.ts';
import { measure, type Scenario, type WindowOptions } from '../measure.ts';
import type { ScenarioResults } from '../results.ts';

const COMPOSER = 'textarea[aria-label="Message"]';
const STOP = 'button[aria-label="Stop the reply"]';
/** The reply is capped so that it outlasts the windows (about 65 s at 70 tokens/s) and still ends on its own. */
const MAX_TOKENS = 8000;
const END_TIMEOUT_MS = 5 * 60_000;
const WINDOWS: WindowOptions[] = [
  { id: 'trace', label: 'Chat streaming, traced', ms: 15_000, trace: true },
  { id: 'clean', label: 'Chat streaming, clean', ms: 15_000 },
  { id: 'profiled', label: 'Chat streaming, profiled', ms: 25_000, profile: true },
];

const chars = async (page: Page): Promise<number> => {
  const n: unknown = await page.evaluate("document.querySelector('main')?.textContent?.length ?? 0");
  return typeof n === 'number' ? n : 0;
};
const streaming = async (page: Page): Promise<boolean> => (await page.$(STOP)) !== null;

export const chat: Scenario<'chat'> = {
  name: 'chat',
  run: async (ctx) => {
    const id = await temporaryConversation(ctx, MAX_TOKENS);
    const page = await openPage(ctx, `/chat/${String(id)}`);
    await page.waitForSelector(COMPOSER, { timeout: 15_000 });
    await page.click(COMPOSER);
    await page.type(COMPOSER, LONG_PROMPT);
    await page.keyboard.press('Enter');
    try {
      await page.waitForSelector(STOP, { timeout: 15_000 });
      await sleep(2000);
      const spans: ScenarioResults['chat']['spans'] = {};
      const windows = [];
      for (const w of WINDOWS) {
        const fromChars = await chars(page);
        if (!(await streaming(page)))
          throw new Error(`the reply ended after ${String(fromChars)} characters, before the ${w.id} window`);
        const window = await measure(ctx, page, w);
        if (w.profile === true) window.census = await census(ctx, page, 8000);
        spans[w.id] = { fromChars, toChars: await chars(page) };
        windows.push(window);
      }
      // Only a reply that ends on its own carries its stats.
      const t0 = now();
      await page.waitForSelector(STOP, { hidden: true, timeout: END_TIMEOUT_MS });
      ctx.log(`the reply ended ${((now() - t0) / 1000).toFixed(0)} s after the last window`);
      const last = await lastReply(ctx, id);
      if (last.stats === null) throw new Error('the reply has no stats: it did not end on its own');
      return {
        reply: { chars: last.chars, tokens: last.stats.genTokens, tokensPerSec: last.stats.tgTps },
        spans,
        windows,
      };
    } finally {
      await ctx.instance.api(`/api/chat/${String(id)}/stop`, { method: 'POST' }).catch(() => undefined);
    }
  },
};
