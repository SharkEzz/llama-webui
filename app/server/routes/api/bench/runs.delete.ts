import { defineHandler } from 'nitro';
import { deps } from '../../../lib/context.ts';
import { HttpError, type QueryOf, queryOf, reply } from '../../../lib/http.ts';

export type Query = QueryOf<'failed'>;

export default defineHandler((event) => {
  if (queryOf(event, 'failed').failed !== '1') throw new HttpError(400, '?failed=1 expected');
  const { benchRuns, hub } = deps();
  const ids = benchRuns.deleteFailed();
  if (ids.length > 0) hub.broadcast({ type: 'bench-deleted', payload: { ids } });
  return reply({ deleted: ids.length });
});
