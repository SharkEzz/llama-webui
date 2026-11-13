import { defineHandler } from 'nitro';
import { sse } from '../../../../lib/chat/sse.ts';
import { deps } from '../../../../lib/context.ts';
import { HttpError, idParam, object, readJson } from '../../../../lib/http.ts';

export type Body = { content: string };

const check = (body: unknown): Body => {
  const { content } = object(body);
  if (typeof content !== 'string') throw new HttpError(400, 'content: expected a string');
  return { content };
};

/** Server-sent events (`web/src/lib/chat.ts` reads them). */
export default defineHandler(async (event) => {
  const id = idParam(event, 'Conversation');
  const { content } = await readJson(event, check);
  return sse(event, deps().chatRuns.send(id, content));
});
