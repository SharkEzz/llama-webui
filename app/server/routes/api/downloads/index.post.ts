import { DownloadRequestSchema } from '@llama-webui/shared';
import { defineHandler } from 'nitro';
import type { z } from 'zod';
import { deps } from '../../../lib/context.ts';
import { downloadInputs } from '../../../lib/hf/repo.ts';
import { readBody, reply } from '../../../lib/http.ts';
import { expandHome } from '../../../lib/supervisor/args.ts';

export type Body = z.input<typeof DownloadRequestSchema>;

export default defineHandler(async (event) => {
  const { hf, downloads, settings } = deps();
  const body = await readBody(event, DownloadRequestSchema);
  const items = await downloads.enqueue(await downloadInputs(hf, body, expandHome(settings.get().modelsDir)));
  return reply({ items }, 202);
});
