import { defineHandler } from 'nitro';
import { deps } from '../../lib/context.ts';
import { reply } from '../../lib/http.ts';
import { serverView } from '../../lib/runtime.ts';

export default defineHandler(() => {
  const { runtime } = deps();
  return reply({ server: serverView(runtime.supervisor), logSeq: runtime.logs.seq, bootId: runtime.bootId });
});
