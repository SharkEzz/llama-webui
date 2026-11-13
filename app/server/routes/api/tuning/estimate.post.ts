import { BenchParamsSchema, PRESET_IDS } from '@llama-webui/shared';
import { defineHandler } from 'nitro';
import { z } from 'zod';
import { deps } from '../../../lib/context.ts';
import { readBody, reply } from '../../../lib/http.ts';
import { estimate } from '../../../lib/tuning/estimate.ts';
import { lastEstimates, tuningHardware } from '../../../lib/tuning/memo.ts';
import { loadModel, mmprojBytes } from '../../../lib/tuning/models.ts';

const EstimateRequest = z.strictObject({
  modelPath: z.string().min(1),
  mmprojPath: z.string().nullish(),
  preset: z.enum(PRESET_IDS),
  pinned: BenchParamsSchema.optional(),
  ctx: z.number().int().min(512).max(10_000_000).optional(),
});

export type Body = z.input<typeof EstimateRequest>;

export default defineHandler(async (event) => {
  const body = await readBody(event, EstimateRequest);
  const [model, mmproj, hw] = await Promise.all([
    loadModel(body.modelPath),
    mmprojBytes(body.mmprojPath),
    tuningHardware(deps()),
  ]);
  const e = estimate({ model, hw, preset: body.preset, mmprojBytes: mmproj, pinned: body.pinned, ctx: body.ctx });
  lastEstimates.set(body.modelPath, e);
  return reply(e);
});
