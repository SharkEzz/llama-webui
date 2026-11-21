import { defineHandler } from 'nitro';
import { detail } from '../../../lib/chat/sse.ts';
import { deps } from '../../../lib/context.ts';
import { HttpError, notFound, object, readJson, reply } from '../../../lib/http.ts';
import { profilePaths } from '../../../lib/supervisor/args.ts';

export type Body = { profileId?: number | null };

/** Omitted: the running server's profile; null: none. `Number(null)` would be 0, a profile that never exists. */
const check = (body: unknown): Body => {
  const raw = object(body).profileId;
  if (raw !== undefined && raw !== null && !Number.isInteger(raw))
    throw new HttpError(400, 'profileId: expected an integer or null');
  return { profileId: raw as number | null | undefined };
};

export default defineHandler(async (event) => {
  const d = deps();
  const raw = (await readJson(event, check)).profileId;
  const id = raw === undefined ? d.activeProfileId() : raw;
  const profile = id !== null ? d.profiles.get(id) : null;
  if (id !== null && !profile) throw notFound('Profile');
  const created = d.conversations.create({
    profileId: profile?.id ?? null,
    modelPath: profile ? profilePaths(profile).model : null,
  });
  return reply(detail(d, created.id), 201);
});
