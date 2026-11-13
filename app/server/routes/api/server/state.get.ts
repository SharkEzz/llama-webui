import { defineHandler } from 'nitro';
import { deps } from '../../../lib/context.ts';
import { reply } from '../../../lib/http.ts';
import { serverView } from '../../../lib/runtime.ts';

export default defineHandler(() => reply(serverView(deps().runtime.supervisor)));
