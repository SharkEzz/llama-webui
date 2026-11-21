import { parseProfileImport } from '@llama-webui/shared';
import { defineHandler } from 'nitro';
import { deps } from '../../../../lib/context.ts';
import { passthrough, readJson, reply } from '../../../../lib/http.ts';

export type Body = unknown;

export default defineHandler(async (event) => {
  const parsed = parseProfileImport(await readJson(event, passthrough));
  const { imported, skipped } = deps().profiles.importMany(parsed.profiles, 'import');
  return reply({ imported, skipped: [...parsed.rejected, ...skipped] });
});
