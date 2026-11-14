import { defineHandler } from 'nitro';
import { deps } from '../../../lib/context.ts';
import { reply } from '../../../lib/http.ts';

export default defineHandler(() => {
  const { monitor, runtime } = deps();
  return reply({ ...monitor.dump(), bootId: runtime.bootId });
});
