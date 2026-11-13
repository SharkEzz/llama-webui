import { defineHandler } from 'nitro';
import { deps } from '../../../lib/context.ts';
import { reply } from '../../../lib/http.ts';

export default defineHandler(() => {
  const { sweeps, benchRunner } = deps();
  return reply({ sweeps: sweeps.list(), live: benchRunner.sweepLive });
});
