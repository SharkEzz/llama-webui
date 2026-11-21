import { defineHandler } from 'nitro';
import { deps } from '../../lib/context.ts';
import { HttpError, reply } from '../../lib/http.ts';
import { binaryPath } from '../../lib/supervisor/args.ts';
import { getFlags } from '../../lib/supervisor/flags.ts';

export default defineHandler(async () => {
  const binary = binaryPath(deps().settings.get());
  const flags = await getFlags(binary);
  if (!flags) throw new HttpError(503, `llama-server --help failed (${binary})`);
  return reply({ flags });
});
