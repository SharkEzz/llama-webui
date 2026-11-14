import { defineHandler } from 'nitro';
import { deps } from '../../../../lib/context.ts';
import { HttpError, idParam, noContent, notFound } from '../../../../lib/http.ts';

export default defineHandler((event) => {
  const id = idParam(event, 'Run');
  const { benchRuns, hub } = deps();
  const run = benchRuns.get(id);
  if (!run) throw notFound('Run');
  if (run.status === 'running') throw new HttpError(409, 'This run is still running: cancel it first');
  benchRuns.delete(id);
  hub.broadcast({ type: 'bench-deleted', payload: { ids: [id] } });
  return noContent();
});
