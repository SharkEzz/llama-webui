import { isDownloadActive } from '@llama-webui/shared';
import { defineHandler } from 'nitro';
import { deps } from '../../../../lib/context.ts';
import { idParam, noContent } from '../../../../lib/http.ts';

/** Cancels a queued or running download, removes a finished one from the list. */
export default defineHandler(async (event) => {
  const id = idParam(event, 'Download');
  const { downloads, downloadsRepo } = deps();
  const item = downloadsRepo.get(id);
  if (item && isDownloadActive(item.status)) await downloads.cancel(id);
  else downloads.remove(id);
  return noContent();
});
