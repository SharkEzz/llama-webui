import { defineHandler } from 'nitro';
import { deps } from '../../../lib/context.ts';
import { reply } from '../../../lib/http.ts';

export default defineHandler(() => reply(deps().monitor.latest()));
