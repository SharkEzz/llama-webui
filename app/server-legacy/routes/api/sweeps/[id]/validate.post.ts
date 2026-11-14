import { type BenchSpec, rankRuns, sweepCtx, withCtx } from '@llama-webui/shared';
import { defineHandler } from 'nitro';
import { z } from 'zod';
import { deps } from '../../../../lib/context.ts';
import { HttpError, idParam, object, reply } from '../../../../lib/http.ts';
import { getSweep, notRunning } from '../../../../lib/sweeps/access.ts';

const ValidateRequest = z.strictObject({
  n: z.number().int().min(1).max(5).default(3),
  stopServer: z.boolean().optional(),
});

export type Body = z.input<typeof ValidateRequest>;

/** Looks the sweep up (404, 409) before reading the body. */
export default defineHandler(async (event) => {
  const d = deps();
  const { benchRuns, benchRunner } = d;
  const sweep = getSweep(d, idParam(event, 'Sweep'));
  notRunning(sweep.status);
  const { n, stopServer } = ValidateRequest.parse(object(await event.req.json()));
  const explored = benchRuns.list({ sweepId: sweep.id }).filter((r) => r.kind === 'bench');
  const best = rankRuns(explored, sweep.spec.preset, sweepCtx(sweep.spec))
    .filter((x) => x.rank !== null)
    .slice(0, n);
  if (best.length === 0) throw new HttpError(409, 'No successful run to validate');
  const { modelPath, mmprojPath, profileId, serverArgs, p, r } = sweep.spec;
  const started = await benchRunner.startSweep(
    () => {
      // An interrupted sweep: its interrupted items are requeued with the validation (otherwise nothing could finish them).
      benchRuns.requeueInterrupted(sweep.id);
      benchRuns.enqueue(
        sweep.id,
        best.map(({ run }) => ({
          spec: {
            kind: 'server',
            modelPath,
            mmprojPath,
            profileId,
            params: run.spec.params,
            // The context the sweep was planned at, not the model's full one (#24).
            serverArgs: withCtx(serverArgs, sweepCtx(sweep.spec)),
            p,
            n: sweep.spec.n,
            r,
          } satisfies BenchSpec,
          label: `validation · ${run.sweepLabel ?? 'base'}`,
          fit: run.fit ?? 'fits',
        })),
      );
      return sweep.id;
    },
    { stopServer: stopServer === true, files: sweep.spec },
  );
  return reply(started, 202);
});
