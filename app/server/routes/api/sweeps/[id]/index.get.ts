import { defineHandler } from 'nitro';
import { deps } from '../../../../lib/context.ts';
import { idParam, reply } from '../../../../lib/http.ts';
import { getSweep } from '../../../../lib/sweeps/access.ts';

export default defineHandler((event) => {
  const d = deps();
  const sweep = getSweep(d, idParam(event, 'Sweep'));
  return reply({ sweep, runs: d.benchRuns.list({ sweepId: sweep.id }) });
});
