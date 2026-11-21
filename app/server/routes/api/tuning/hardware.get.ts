import { defineHandler } from 'nitro';
import { deps } from '../../../lib/context.ts';
import { reply } from '../../../lib/http.ts';
import { tuningHardware } from '../../../lib/tuning/memo.ts';

export default defineHandler(async () => reply(await tuningHardware(deps())));
