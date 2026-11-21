import { defineHandler } from 'nitro';
import { sse } from '../../../../lib/chat/sse.ts';
import { deps } from '../../../../lib/context.ts';
import { idParam, notFound } from '../../../../lib/http.ts';

/** The reply being generated, over server-sent events; 204 when there is none. */
export default defineHandler((event) => {
  const id = idParam(event, 'Conversation');
  const { conversations, chatRuns } = deps();
  if (!conversations.get(id)) throw notFound('Conversation');
  const run = chatRuns.live(id);
  return run ? sse(event, run) : new Response(null, { status: 204 });
});
