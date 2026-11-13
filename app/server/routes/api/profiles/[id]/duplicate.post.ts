import { defineHandler } from 'nitro';
import { deps } from '../../../../lib/context.ts';
import { idParam, reply } from '../../../../lib/http.ts';

export default defineHandler((event) => reply(deps().profiles.duplicate(idParam(event, 'Profile')), 201));
