// generation: the Dashboard while a long reply is generated through the app's chat API, in a temporary conversation.
import { openPage } from '../browser.ts';
import { LONG_PROMPT, sendMessage, temporaryConversation } from '../chat-api.ts';
import { sleep } from '../instance.ts';
import { measure, type Scenario, type WindowOptions } from '../measure.ts';

const WINDOWS: WindowOptions[] = [
  { id: 'clean', label: 'Dashboard during a generation, clean', ms: 30_000, ws: true },
  { id: 'profiled', label: 'Dashboard during a generation, profiled', ms: 30_000, profile: true },
  { id: 'trace', label: 'Dashboard during a generation, traced', ms: 20_000, trace: true },
];

export const generation: Scenario<'generation'> = {
  name: 'generation',
  run: async (ctx) => {
    const page = await openPage(ctx, '/');
    const id = await temporaryConversation(ctx);
    const reply = sendMessage(ctx, id, LONG_PROMPT);
    const ended = { at: false };
    reply.done.then(
      () => (ended.at = true),
      () => (ended.at = true),
    );
    try {
      // The prompt is evaluated and the first tokens stream before the first window.
      await sleep(3000);
      const windows = [];
      for (const w of WINDOWS) {
        if (ended.at) throw new Error(`the reply ended before the ${w.id} window`);
        windows.push(await measure(ctx, page, w));
      }
      return { windows };
    } finally {
      await reply.stop();
    }
  },
};
