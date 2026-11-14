import { defineHandler } from 'nitro';
import { deps } from '../../../lib/context.ts';
import { reply } from '../../../lib/http.ts';

export default defineHandler(() => {
  const { downloads, downloadsRepo } = deps();
  return reply({ items: downloadsRepo.list(), live: downloads.live });
});
