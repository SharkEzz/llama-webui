import { ModelPathRefused } from '@llama-webui/shared';
import { Array as Arr, Effect, FileSystem, Path, String as Str } from 'effect';
import { ProfilesRepo } from '../profiles/ProfilesRepo.ts';
import type { SettingsRepo } from '../settings/SettingsRepo.ts';
import { resolveProfilePaths } from '../supervisor/command.ts';
import { modelsRoot } from './access.ts';

const refused = () => ModelPathRefused.make({ message: 'Outside the models folder and not used by a profile' });

/**
 * Whether a request may open the model or projector at `path`: a path under the models folder (as written, `..`
 * resolved, or once its links are followed: the folder itself may be a link), or the model or projector of a profile,
 * as written or once both are followed. A link the user put under the models folder is under it, wherever it leads:
 * the scan lists it. A path that does not exist is judged as written, before the caller's 404: the answer tells
 * nothing of a file outside. A profile opens its paths to every request, as it opens them to llama-server.
 */
export const checkModelPath = Effect.fn('models.checkModelPath')(function* (
  path: string,
): Effect.fn.Return<void, ModelPathRefused, SettingsRepo | ProfilesRepo | FileSystem.FileSystem | Path.Path> {
  const fs = yield* FileSystem.FileSystem;
  const paths = yield* Path.Path;
  /** `file` once its links are followed, or as written when that fails (a missing file). */
  const real = (file: string) => fs.realPath(file).pipe(Effect.orElseSucceed(() => paths.resolve(file)));
  const written = paths.resolve(path);
  const followed = yield* real(path);

  const { dir } = yield* modelsRoot;
  const under = (root: string) => Str.startsWith(root === '/' ? '/' : `${root}${paths.sep}`);
  const roots = [paths.resolve(dir), yield* real(dir)];
  if (Arr.some(roots, (root) => under(root)(written) || under(root)(followed))) return;

  const profiles = yield* ProfilesRepo;
  const all = yield* profiles.list;
  const resolved = yield* Effect.forEach(all, resolveProfilePaths);
  const opened = Arr.flatMap(resolved, ({ model, mmproj }) => (mmproj === null ? [model] : [model, mmproj]));
  if (Arr.contains(opened, written)) return;
  const openedReal = yield* Effect.forEach(opened, real);
  if (Arr.contains(openedReal, followed)) return;
  return yield* refused();
});

/** `checkModelPath` of a model and of its projector when there is one. */
export const checkModelPaths = Effect.fn('models.checkModelPaths')(function* (files: {
  readonly modelPath: string;
  readonly mmprojPath?: string | null | undefined;
}) {
  yield* checkModelPath(files.modelPath);
  if (files.mmprojPath !== null && files.mmprojPath !== undefined && !Str.isEmpty(files.mmprojPath)) {
    yield* checkModelPath(files.mmprojPath);
  }
});
