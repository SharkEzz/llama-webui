import { defineHandler } from 'nitro';
import { deps } from '../../../lib/context.ts';
import { describeRepo } from '../../../lib/hf/repo.ts';
import { type QueryOf, queryOf, reply } from '../../../lib/http.ts';
import { expandHome } from '../../../lib/supervisor/args.ts';

export type Query = QueryOf<'id' | 'revision'>;

export default defineHandler(async (event) => {
  const { hf, settings } = deps();
  const q = queryOf(event, 'id', 'revision');
  const repo = await describeRepo(hf, q.id ?? '', {
    modelsDir: expandHome(settings.get().modelsDir),
    revision: q.revision || undefined,
    signal: event.req.signal,
  });
  return reply(repo);
});
