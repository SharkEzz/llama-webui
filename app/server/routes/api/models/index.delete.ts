import { type ModelDeleted, ModelDeleteSchema } from '@llama-webui/shared';
import { defineHandler } from 'nitro';
import type { z } from 'zod';
import { deps } from '../../../lib/context.ts';
import { HttpError, readBody, reply } from '../../../lib/http.ts';
import { entryOf, modelUsers } from '../../../lib/models/access.ts';
import { deleteModelFiles, modelUsage } from '../../../lib/models/delete.ts';
import { removeProfile } from '../../../lib/profiles/remove.ts';

export type Body = z.input<typeof ModelDeleteSchema>;

export default defineHandler(async (event) => {
  const d = deps();
  const body = await readBody(event, ModelDeleteSchema);
  const { dir, entry } = await entryOf(d, body.path);
  const usage = await modelUsage(entry, modelUsers(d));
  if (usage.blocked) throw new HttpError(409, usage.blocked, 'model-in-use');
  await deleteModelFiles(entry, dir);
  const deletedProfiles = body.deleteProfiles ? usage.profiles.map((p) => p.id) : [];
  for (const id of deletedProfiles) removeProfile(d, id);
  const result: ModelDeleted = { deletedFiles: entry.files, deletedProfiles };
  return reply(result);
});
