import { defineHandler } from 'nitro';
import { deps } from '../../../../lib/context.ts';
import { HttpError, idParam, noContent } from '../../../../lib/http.ts';

export default defineHandler((event) => {
  if (!deps().chatRuns.stop(idParam(event, 'Conversation'))) throw new HttpError(409, 'No reply in progress');
  return noContent();
});
