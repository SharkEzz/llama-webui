import { defineHandler } from 'nitro';
import { z } from 'zod';
import { deps } from '../../../lib/context.ts';
import { HttpError, readBody, reply } from '../../../lib/http.ts';
import { measureDiskSpeed } from '../../../lib/tuning/disk.ts';
import { diskSpeeds } from '../../../lib/tuning/memo.ts';
import { loadModel } from '../../../lib/tuning/models.ts';

const DiskSpeedRequest = z.strictObject({ modelPath: z.string().min(1) });

export type Body = z.input<typeof DiskSpeedRequest>;

export default defineHandler(async (event) => {
  const { modelPath } = await readBody(event, DiskSpeedRequest);
  if (deps().benchRunner.busy) throw new HttpError(409, 'A benchmark is running: the measurement would be skewed');
  await loadModel(modelPath);
  const d = await measureDiskSpeed(modelPath);
  diskSpeeds.set(modelPath, d);
  return reply(d);
});
