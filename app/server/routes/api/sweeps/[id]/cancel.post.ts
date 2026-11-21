import { defineHandler } from 'nitro';
import { deps } from '../../../../lib/context.ts';
import { HttpError, idParam, noContent } from '../../../../lib/http.ts';
import { getSweep } from '../../../../lib/sweeps/access.ts';

export default defineHandler((event) => {
  const d = deps();
  if (!d.benchRunner.cancelSweep(getSweep(d, idParam(event, 'Sweep')).id))
    throw new HttpError(409, 'This sweep is not running');
  return noContent();
});
