import { homedir } from 'node:os';
import { type BenchSpec, paramsFromServerArgs } from '@llama-webui/shared';
import { defineHandler } from 'nitro';
import { deps } from '../../../../lib/context.ts';
import { idParam, notFound, reply } from '../../../../lib/http.ts';
import { profilePaths } from '../../../../lib/supervisor/args.ts';

export default defineHandler((event) => {
  const profile = deps().profiles.get(idParam(event, 'Profile'));
  if (!profile) throw notFound('Profile');
  const paths = profilePaths(profile, homedir());
  const { params, rest } = paramsFromServerArgs(profile.args);
  const draft: Pick<BenchSpec, 'modelPath' | 'mmprojPath' | 'profileId' | 'params' | 'serverArgs'> = {
    modelPath: paths.model,
    mmprojPath: paths.mmproj,
    profileId: profile.id,
    params,
    serverArgs: rest,
  };
  return reply(draft);
});
