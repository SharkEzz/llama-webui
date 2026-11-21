import { defineHandler } from 'nitro';
import { deps } from '../../../lib/context.ts';
import { HttpError, type QueryOf, queryOf, reply } from '../../../lib/http.ts';

export type Query = QueryOf<'q'>;

export default defineHandler(async (event) => {
  const q = (queryOf(event, 'q').q ?? '').trim();
  if (!q || q.length > 200) throw new HttpError(400, 'Search text expected (200 characters at most)');
  return reply(await deps().hf.search(q, { signal: event.req.signal }));
});
