import { defineHandler } from 'nitro';
import { deps } from '../../../../lib/context.ts';
import { idParam, reply } from '../../../../lib/http.ts';

export default defineHandler(async (event) => reply(await deps().downloads.retry(idParam(event, 'Download')), 202));
