import { defineHandler } from 'nitro';
import { deps } from '../../../lib/context.ts';
import { object, readJson, reply } from '../../../lib/http.ts';
import { serverView } from '../../../lib/runtime.ts';
import { commandFor, lifecycle, remember } from '../../../lib/supervisor/control.ts';

export type Body = Record<string, unknown>;

export default defineHandler(async (event) => {
  const d = deps();
  const { supervisor } = d.runtime;
  const cmd = commandFor(d, (await readJson(event, object)).profileId);
  await lifecycle(d, () => supervisor.start(cmd));
  remember(d, cmd.profileId);
  return reply(serverView(supervisor), 202);
});
