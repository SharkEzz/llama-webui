import { defineHandler } from 'nitro';
import { deps } from '../../../../lib/context.ts';
import { toInput } from '../../../../lib/db/profiles.ts';
import { attachment, idParam, notFound } from '../../../../lib/http.ts';

export default defineHandler((event) => {
  const p = deps().profiles.get(idParam(event, 'Profile'));
  if (!p) throw notFound('Profile');
  return attachment(`${p.name}.json`, toInput(p));
});
