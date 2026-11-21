import { defineHandler } from 'nitro';
import { detail } from '../../../../lib/chat/sse.ts';
import { deps } from '../../../../lib/context.ts';
import { idParam, reply } from '../../../../lib/http.ts';

export default defineHandler((event) => reply(detail(deps(), idParam(event, 'Conversation'))));
