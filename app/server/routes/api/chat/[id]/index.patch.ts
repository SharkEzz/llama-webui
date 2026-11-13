import { defineHandler } from 'nitro';
import { detail } from '../../../../lib/chat/sse.ts';
import { deps } from '../../../../lib/context.ts';
import { idParam, object, readJson, reply } from '../../../../lib/http.ts';

export type Body = Record<string, unknown>;

export default defineHandler(async (event) => {
  const id = idParam(event, 'Conversation');
  const d = deps();
  d.conversations.patch(id, await readJson(event, object));
  return reply(detail(d, id));
});
