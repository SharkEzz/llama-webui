import { defineHandler } from 'nitro';
import { deps } from '../../../../lib/context.ts';
import { idParam, notFound, reply } from '../../../../lib/http.ts';

export default defineHandler((event) => {
  const profile = deps().profiles.get(idParam(event, 'Profile'));
  if (!profile) throw notFound('Profile');
  return reply(profile);
});
