import { BenchSpecSchema } from '@llama-webui/shared';
import { defineHandler } from 'nitro';
import { deps } from '../../../lib/context.ts';
import { object, readJson, reply } from '../../../lib/http.ts';

export type Body = Record<string, unknown>;

/** The spec is a field of the body: its errors keep their paths (`kind`, not `spec.kind`). */
export default defineHandler(async (event) => {
  const body = await readJson(event, object);
  const spec = BenchSpecSchema.parse(body.spec);
  const run = await deps().benchRunner.start(spec, { stopServer: body.stopServer === true });
  return reply(run, 202);
});
