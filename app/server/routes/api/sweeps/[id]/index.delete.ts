import { defineHandler } from 'nitro';
import { deps } from '../../../../lib/context.ts';
import { idParam, noContent } from '../../../../lib/http.ts';
import { getSweep, notRunning } from '../../../../lib/sweeps/access.ts';

export default defineHandler((event) => {
  const d = deps();
  const sweep = getSweep(d, idParam(event, 'Sweep'));
  notRunning(sweep.status);
  const ids = d.sweeps.delete(sweep.id);
  d.hub.broadcast({ type: 'bench-deleted', payload: { ids } });
  d.hub.broadcast({ type: 'sweep-deleted', payload: { id: sweep.id } });
  return noContent();
});
