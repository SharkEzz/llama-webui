import { SweepSpecSchema } from '@llama-webui/shared';
import { defineHandler } from 'nitro';
import { deps } from '../../../lib/context.ts';
import { object, readJson, reply } from '../../../lib/http.ts';
import { tuningHardware } from '../../../lib/tuning/memo.ts';
import { loadModel, mmprojBytes } from '../../../lib/tuning/models.ts';
import { planSweep } from '../../../lib/tuning/space.ts';

export type Body = Record<string, unknown>;

/** The spec is a field of the body: its errors keep their paths (`modelPath`, not `spec.modelPath`). */
export default defineHandler(async (event) => {
  const spec = SweepSpecSchema.parse((await readJson(event, object)).spec);
  const [model, mmproj, hw] = await Promise.all([
    loadModel(spec.modelPath),
    mmprojBytes(spec.mmprojPath),
    tuningHardware(deps()),
  ]);
  return reply(planSweep({ model, hw, spec, mmprojBytes: mmproj }));
});
