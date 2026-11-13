import { defineHandler } from 'nitro';
import { deps } from '../../../../lib/context.ts';
import { HttpError, idParam, noContent } from '../../../../lib/http.ts';

export default defineHandler((event) => {
  if (!deps().benchRunner.cancel(idParam(event, 'Run'))) throw new HttpError(409, 'This run is not running');
  return noContent();
});
