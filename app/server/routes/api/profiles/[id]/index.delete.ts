import { defineHandler } from 'nitro';
import { deps } from '../../../../lib/context.ts';
import { idParam, noContent } from '../../../../lib/http.ts';
import { removeProfile } from '../../../../lib/profiles/remove.ts';

export default defineHandler((event) => {
  removeProfile(deps(), idParam(event, 'Profile'));
  return noContent();
});
