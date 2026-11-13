import { ModelCacheRepo } from '../db/modelCache';
import type { AppDeps } from '../deps';
import { expandHome } from '../supervisor/args';
import { findEntry, type ModelUsers } from './delete';
import { scanModels } from './scan';

/** The models folder: the setting as typed, and expanded. */
export const modelsDir = ({ settings }: Pick<AppDeps, 'settings'>) => {
  const setting = settings.get().modelsDir;
  return { setting, dir: expandHome(setting) };
};

/** What uses a model file: profiles, the running server, a benchmark or sweep, a download. */
export const modelUsers = (deps: AppDeps): ModelUsers => ({
  profiles: deps.profiles,
  activeProfileId: deps.activeProfileId,
  benchFiles: () => {
    const live = deps.benchRunner.live;
    const run = live ? deps.benchRuns.get(live.runId) : null;
    const sweep = deps.sweeps.running();
    return [run?.spec.modelPath, run?.spec.mmprojPath, sweep?.spec.modelPath, sweep?.spec.mmprojPath].map(
      (p) => p ?? null,
    );
  },
  downloads: () => deps.downloadsRepo.active(),
});

/** The model at `path`, from a fresh scan of the models folder (never a path taken as is from the client). */
export const entryOf = async (deps: AppDeps, path: string) => {
  const { dir } = modelsDir(deps);
  return { dir, entry: findEntry(await scanModels(dir, { cache: new ModelCacheRepo(deps.db) }), dir, path) };
};
