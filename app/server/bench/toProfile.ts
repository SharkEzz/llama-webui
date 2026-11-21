import {
  type BenchDraft,
  type BenchRun,
  type Profile,
  type ProfileInput,
  paramsFromServerArgs,
  profileModelPath,
  RunNotFound,
  RunStillRunning,
  type Sweep,
  serverArgs,
  sweepCtx,
  withCtx,
} from '@llama-webui/shared';
import { Array as Arr, Effect, Option, Path } from 'effect';
import { homeDir } from '../config/Home.ts';
import { ProfilesRepo } from '../profiles/ProfilesRepo.ts';
import { SettingsRepo } from '../settings/SettingsRepo.ts';
import { profilePaths } from '../supervisor/command.ts';
import { BenchRunsRepo } from './BenchRunsRepo.ts';
import { SweepsRepo } from './SweepsRepo.ts';

/** `<stem> — bench #<id>`, then `<stem> — bench #<id> (2)`, `(3)`…: the first that is not `taken`. */
export const profileName = (options: {
  readonly stem: string;
  readonly runId: number;
  readonly taken: ReadonlySet<string>;
}): string => {
  const base = `${options.stem} — bench #${options.runId}`;
  let name = base;
  for (let n = 2; options.taken.has(name); n++) name = `${base} (${n})`;
  return name;
};

/**
 * The profile a run becomes: the model (and projector) relative to the models folder when they are in it, the folder
 * as the setting types it; the flags of the fields, then the other flags, with the sweep's context when the run is a
 * sweep item whose flags set none (#24); the variables of the source profile.
 */
export const profileInputOf = (options: {
  readonly run: BenchRun;
  readonly name: string;
  readonly sweep: Option.Option<Sweep>;
  readonly source: Option.Option<Profile>;
  readonly modelsDir: string;
  readonly home: string;
}): ProfileInput => {
  const { run, modelsDir, home } = options;
  const { spec } = run;
  const placed = profileModelPath(spec.modelPath, { modelsDir, home });
  const mmproj =
    spec.mmprojPath === null || spec.mmprojPath === ''
      ? Option.none<string>()
      : Option.some(profileModelPath(spec.mmprojPath, { cwd: placed.cwd, modelsDir, home }).model);
  const ctx = Option.map(options.sweep, (sweep) => sweepCtx(sweep.spec));
  return {
    name: options.name,
    model: placed.model,
    ...Option.match(mmproj, { onNone: () => ({}), onSome: (file) => ({ mmproj: file }) }),
    ...(placed.cwd === undefined || placed.cwd === '' ? {} : { cwd: placed.cwd }),
    args: [...serverArgs(spec.params), ...withCtx(spec.serverArgs, Option.getOrNull(ctx))],
    env: Option.match(options.source, { onNone: () => ({}), onSome: (profile) => ({ ...profile.env }) }),
  };
};

/** A new profile from a run that is not running (`POST /api/bench/:id/to-profile`). */
export const toProfile = Effect.fn('bench.toProfile')(function* (id: number) {
  const runs = yield* BenchRunsRepo;
  const sweeps = yield* SweepsRepo;
  const profiles = yield* ProfilesRepo;
  const settings = yield* SettingsRepo;
  const path = yield* Path.Path;
  const found = yield* runs.get(id);
  if (Option.isNone(found)) return yield* RunNotFound.make({ message: 'Run not found' });
  const run = found.value;
  if (run.status === 'running') return yield* RunStillRunning.make({ message: 'This run is still running' });
  const source =
    run.spec.profileId === null ? Option.none<Profile>() : yield* profiles.get(run.spec.profileId).pipe(Effect.option);
  // A sweep item: the context it was planned at, not the model's full one (#24).
  const sweep = run.sweepId === null ? Option.none<Sweep>() : yield* sweeps.get(run.sweepId);
  const all = yield* profiles.list;
  const name = profileName({
    stem: path.basename(run.spec.modelPath, '.gguf'),
    runId: run.id,
    taken: new Set(Arr.map(all, (profile) => profile.name)),
  });
  const { modelsDir } = yield* settings.get;
  const home = yield* homeDir;
  return yield* profiles.create(profileInputOf({ run, name, sweep, source, modelsDir, home }));
});

/**
 * The draft of a run from a profile (`GET /api/bench/from-profile/:id`): its model and projector resolved against its
 * folder (`~` expanded), its flags split into the fields and the other flags.
 */
export const fromProfile = Effect.fn('bench.fromProfile')(function* (id: number) {
  const profiles = yield* ProfilesRepo;
  const path = yield* Path.Path;
  const profile = yield* profiles.get(id);
  const home = yield* homeDir;
  const files = profilePaths({ profile, home, cwd: path.resolve('.'), path });
  const { params, rest } = paramsFromServerArgs(profile.args);
  const draft: BenchDraft = {
    modelPath: files.model,
    mmprojPath: files.mmproj,
    profileId: profile.id,
    params,
    serverArgs: rest,
  };
  return draft;
});
