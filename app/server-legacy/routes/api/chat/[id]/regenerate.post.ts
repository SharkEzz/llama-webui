import { defineHandler } from 'nitro';
import { sse } from '../../../../lib/chat/sse.ts';
import { deps } from '../../../../lib/context.ts';
import { idParam } from '../../../../lib/http.ts';

/** Server-sent events (`src/lib/chat.ts` reads them). */
export default defineHandler((event) => sse(event, deps().chatRuns.regenerate(idParam(event, 'Conversation'))));
