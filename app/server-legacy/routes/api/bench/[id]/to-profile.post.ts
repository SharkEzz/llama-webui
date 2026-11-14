import { homedir } from 'node:os';
import { basename } from 'node:path';
import { profileModelPath, serverArgs, sweepCtx, withCtx } from '@llama-webui/shared';
import { defineHandler } from 'nitro';
import { deps } from '../../../../lib/context.ts';
import { HttpError, idParam, notFound, reply } from '../../../../lib/http.ts';

export default defineHandler((event) => {
  const { benchRuns, settings, profiles, sweeps } = deps();
  const run = benchRuns.get(idParam(event, 'Run'));
  if (!run) throw notFound('Run');
  if (run.status === 'running') throw new HttpError(409, 'This run is still running');
  const { spec } = run;
  const home = homedir();
  const modelsDir = settings.get().modelsDir;
  const placed = profileModelPath(spec.modelPath, { modelsDir, home });
  const mmproj = spec.mmprojPath
    ? profileModelPath(spec.mmprojPath, { cwd: placed.cwd, modelsDir, home }).model
    : undefined;
  const origin = spec.profileId !== null ? profiles.get(spec.profileId) : null;
  // A sweep run: the context it was planned at, not the model's full one (#24).
  const sweep = run.sweepId !== null ? sweeps.get(run.sweepId) : null;
  // Free name: “<base>”, then “<base> (2)”, “(3)”…
  const base = `${basename(spec.modelPath).replace(/\.gguf$/, '')} — bench #${run.id}`;
  const taken = new Set(profiles.list().map((p) => p.name));
  let name = base;
  for (let n = 2; taken.has(name); n++) name = `${base} (${n})`;
  const profile = profiles.create({
    name,
    model: placed.model,
    ...(mmproj ? { mmproj } : {}),
    ...(placed.cwd ? { cwd: placed.cwd } : {}),
    args: [...serverArgs(spec.params), ...withCtx(spec.serverArgs, sweep ? sweepCtx(sweep.spec) : null)],
    env: origin?.env ?? {},
  });
  return reply(profile, 201);
});
