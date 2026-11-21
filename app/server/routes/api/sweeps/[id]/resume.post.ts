import { defineHandler } from 'nitro';
import { deps } from '../../../../lib/context.ts';
import { HttpError, idParam, object, reply } from '../../../../lib/http.ts';
import { getSweep, notRunning } from '../../../../lib/sweeps/access.ts';

export type Body = { stopServer?: boolean };

/** Looks the sweep up (404, 409) before reading the body. */
export default defineHandler(async (event) => {
  const d = deps();
  const { benchRuns, benchRunner } = d;
  const sweep = getSweep(d, idParam(event, 'Sweep'));
  notRunning(sweep.status);
  const body = object(await event.req.json());
  const started = await benchRunner.startSweep(
    () => {
      benchRuns.requeueInterrupted(sweep.id);
      if (!benchRuns.nextQueued(sweep.id)) throw new HttpError(409, 'Nothing to resume: no interrupted or queued item');
      return sweep.id;
    },
    { stopServer: body.stopServer === true, files: sweep.spec },
  );
  return reply(started, 202);
});
