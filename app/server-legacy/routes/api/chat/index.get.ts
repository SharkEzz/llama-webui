import type { ConversationSummary } from '@llama-webui/shared';
import { defineHandler } from 'nitro';
import { deps } from '../../../lib/context.ts';
import { reply } from '../../../lib/http.ts';

export default defineHandler(() => {
  const { conversations, chatRuns } = deps();
  return reply(
    conversations.list().map((c): ConversationSummary => ({ ...c, live: chatRuns.live(c.id) !== undefined })),
  );
});
