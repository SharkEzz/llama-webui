import { type BenchSpec, SweepSpecSchema } from '@llama-webui/shared';
import { defineHandler } from 'nitro';
import { deps } from '../../../lib/context.ts';
import { HttpError, object, readJson, reply } from '../../../lib/http.ts';
import { tuningHardware } from '../../../lib/tuning/memo.ts';
import { loadModel, mmprojBytes } from '../../../lib/tuning/models.ts';
import { planSweep } from '../../../lib/tuning/space.ts';

export type Body = Record<string, unknown>;

/** The spec is a field of the body: its errors keep their paths (`modelPath`, not `spec.modelPath`). */
export default defineHandler(async (event) => {
  const d = deps();
  const { sweeps, benchRuns, benchRunner } = d;
  const body = await readJson(event, object);
  const spec = SweepSpecSchema.parse(body.spec);
  const [model, mmproj, hw] = await Promise.all([
    loadModel(spec.modelPath),
    mmprojBytes(spec.mmprojPath),
    tuningHardware(d),
  ]);
  const plan = planSweep({ model, hw, spec, mmprojBytes: mmproj });
  if (plan.items.length === 0)
    throw new HttpError(409, `No configuration to run: ${plan.excluded} excluded by the estimator`);
  const { modelPath, mmprojPath, profileId, serverArgs, p, n, r } = spec;
  const sweep = await benchRunner.startSweep(
    () => {
      const s = sweeps.create(spec);
      benchRuns.enqueue(
        s.id,
        plan.items.map((it) => ({
          spec: {
            kind: 'bench',
            modelPath,
            mmprojPath,
            profileId,
            params: it.params,
            serverArgs,
            p,
            n,
            r,
          } satisfies BenchSpec,
          label: it.label,
          fit: it.fit.verdict,
        })),
      );
      return s.id;
    },
    { stopServer: body.stopServer === true },
  );
  return reply({ sweep, items: plan.items.length, excluded: plan.excluded }, 202);
});
