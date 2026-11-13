import { defineHandler } from 'nitro';
import { deps } from '../../../../lib/context.ts';
import { idParam, noContent } from '../../../../lib/http.ts';

export default defineHandler(async (event) => {
  const id = idParam(event, 'Conversation');
  const { chatRuns, conversations } = deps();
  const run = chatRuns.live(id);
  if (run) {
    chatRuns.stop(id);
    await run.done.catch(() => {});
  }
  conversations.delete(id);
  return noContent();
});
