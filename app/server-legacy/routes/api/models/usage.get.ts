import { defineHandler } from 'nitro';
import { deps } from '../../../lib/context.ts';
import { HttpError, type QueryOf, queryOf, reply } from '../../../lib/http.ts';
import { entryOf, modelUsers } from '../../../lib/models/access.ts';
import { modelUsage } from '../../../lib/models/delete.ts';

export type Query = QueryOf<'path'>;

export default defineHandler(async (event) => {
  const { path } = queryOf(event, 'path');
  if (!path) throw new HttpError(400, 'path required');
  const d = deps();
  return reply(await modelUsage((await entryOf(d, path)).entry, modelUsers(d)));
});
