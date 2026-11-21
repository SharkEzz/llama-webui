import { defineHandler } from 'nitro';
import { deps } from '../../../../lib/context.ts';
import { idParam, passthrough, readJson, reply } from '../../../../lib/http.ts';

export type Body = unknown;

/** The repo looks the profile up before parsing the body (404 beats 400): the body is passed as sent. */
export default defineHandler(async (event) => {
  const id = idParam(event, 'Profile');
  return reply(deps().profiles.update(id, await readJson(event, passthrough)));
});
