import { defineHandler } from 'nitro';
import { deps } from '../../../lib/context.ts';
import { HttpError, reply } from '../../../lib/http.ts';
import { serverView } from '../../../lib/runtime.ts';
import { commandFor, lifecycle } from '../../../lib/supervisor/control.ts';

export default defineHandler(async () => {
  const d = deps();
  const { supervisor } = d.runtime;
  const id = serverView(supervisor).profileId;
  if (id === null) throw new HttpError(409, 'No profile to restart');
  const cmd = commandFor(d, id); // re-read from the DB: profile changes are taken into account
  await lifecycle(d, () => supervisor.switchTo(cmd));
  return reply(serverView(supervisor), 202);
});
