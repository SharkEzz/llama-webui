import { defineHandler } from 'nitro';
import { deps } from '../../../lib/context.ts';
import { reply } from '../../../lib/http.ts';
import { serverView } from '../../../lib/runtime.ts';
import { lifecycle } from '../../../lib/supervisor/control.ts';

export default defineHandler(async () => {
  const d = deps();
  const { supervisor } = d.runtime;
  await lifecycle(d, () => supervisor.stop());
  return reply(serverView(supervisor));
});
