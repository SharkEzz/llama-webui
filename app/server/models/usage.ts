// @effect-diagnostics-next-line nodeBuiltinImport:off FileSystem of effect has no rmdir: an empty folder goes in one step
import { rmdir } from 'node:fs/promises';
import {
  activeProfileId,
  type ModelDeleted,
  type ModelEntry,
  ModelInUse,
  type ModelProfileUse,
  type ModelUsage,
  type ProfileRunning,
} from '@llama-webui/shared';
import { Array as Arr, Effect, FileSystem, Option, Order, Path, String as Str } from 'effect';
import { BenchRunner } from '../bench/BenchRunner.ts';
import { homeDir } from '../config/Home.ts';
import { ProfilesRepo } from '../profiles/ProfilesRepo.ts';
import { removeProfile } from '../profiles/removeProfile.ts';
import type { SettingsRepo } from '../settings/SettingsRepo.ts';
import { profilePaths } from '../supervisor/command.ts';
import { Supervisor } from '../supervisor/Supervisor.ts';
import { ActiveWrites } from './ActiveWrites.ts';

/**
 * Whether a path another part of the app opens is one of `files`: as written (resolved), or once its links are
 * followed (a profile that goes through a symlinked folder). Not the other way: deleting a link leaves its target,
 * and what uses the target.
 */
const matcher = Effect.fnUntraced(function* (files: ReadonlyArray<string>) {
  const fs = yield* FileSystem.FileSystem;
  const paths = yield* Path.Path;
  const set = new Set(files);
  return (file: string | null): Effect.Effect<boolean> =>
    file === null
      ? Effect.succeed(false)
      : set.has(paths.resolve(file))
        ? Effect.succeed(true)
        : fs.realPath(file).pipe(
            Effect.map((real) => set.has(real)),
            Effect.orElseSucceed(() => false),
          );
});

/** Where a download writes `file` in `dir`; none for a path that leaves `dir` (refused when it was queued). */
const destOf = (paths: Path.Path, dir: string, file: string): Option.Option<string> => {
  const root = paths.resolve(dir);
  const dest = paths.resolve(root, file);
  return !paths.isAbsolute(file) && Str.startsWith(`${root}${paths.sep}`)(dest) ? Option.some(dest) : Option.none();
};

/**
 * What deleting the model would remove (its files, the profiles that open it, as their model checked first, then as
 * their projector) and why it is refused now (`blocked`), in this order: the server llama-webui runs opens it, a
 * benchmark in progress (a run or a running sweep) opens it, or a download in progress writes one of its files.
 */
export const modelUsage = Effect.fn('models.modelUsage')(function* (
  entry: ModelEntry,
): Effect.fn.Return<
  ModelUsage,
  never,
  ProfilesRepo | Supervisor | BenchRunner | ActiveWrites | FileSystem.FileSystem | Path.Path
> {
  const profiles = yield* ProfilesRepo;
  const supervisor = yield* Supervisor;
  const runner = yield* BenchRunner;
  const writes = yield* ActiveWrites;
  const paths = yield* Path.Path;
  const home = yield* homeDir;
  const cwd = paths.resolve('.');
  const uses = yield* matcher(entry.files);
  /** Whether one of `files` is one of the model's. */
  const usesAny = (files: ReadonlyArray<string | null>) =>
    Effect.findFirst(files, (file) => uses(file)).pipe(Effect.map(Option.isSome));
  const all = yield* profiles.list;
  const opened = Arr.map(all, (profile) => ({ profile, ...profilePaths({ profile, home, cwd, path: paths }) }));

  const roles = yield* Effect.forEach(opened, ({ profile, model, mmproj }) =>
    Effect.gen(function* () {
      const { id, name } = profile;
      if (yield* uses(model)) return Option.some<ModelProfileUse>({ id, name, role: 'model' });
      if (yield* uses(mmproj)) return Option.some<ModelProfileUse>({ id, name, role: 'mmproj' });
      return Option.none<ModelProfileUse>();
    }),
  );

  const state = yield* supervisor.state;
  const activeId = activeProfileId(state);
  // The profile of the server llama-webui runs, when it opens the model.
  const running = yield* Effect.filter(
    Arr.filter(opened, ({ profile }) => profile.id === activeId),
    ({ model, mmproj }) => usesAny([model, mmproj]),
  );
  /** Without the running server: a benchmark in progress first, then a download. */
  const otherUse = Effect.gen(function* () {
    const benchFiles = yield* runner.files;
    if (yield* usesAny(benchFiles)) return 'A benchmark in progress uses it';
    const items = yield* writes.active;
    const dests = Arr.flatMap(items, (item) =>
      Arr.getSomes(Arr.map(item.files, (file) => destOf(paths, item.dir, file.path))),
    );
    const written = yield* usesAny(dests);
    return written ? 'A download in progress writes it' : null;
  });
  const blocked = yield* Arr.match(running, {
    onEmpty: () => otherUse,
    onNonEmpty: ([{ profile }]) =>
      Effect.succeed(`The running server uses it (profile “${profile.name}”): stop it first`),
  });

  return {
    path: entry.path,
    files: entry.files,
    fileBytes: entry.fileBytes,
    profiles: Arr.getSomes(roles),
    blocked,
  };
});

/** Deepest first: a folder goes before its parent. */
const deepestFirst = Order.flip(Order.mapInput(Order.Number, (dir: string) => dir.length));

/**
 * The folders between each of `files` and `root` (both excluded), deepest first. A folder that is left empty once the
 * files are gone is removed; the models folder itself never is.
 */
const foldersUnder = (paths: Path.Path, root: string, files: ReadonlyArray<string>): ReadonlyArray<string> => {
  const base = `${paths.resolve(root)}${paths.sep}`;
  const dirs = new Set<string>();
  for (const file of files) {
    for (let dir = paths.dirname(paths.resolve(file)); Str.startsWith(base)(dir); dir = paths.dirname(dir)) {
      dirs.add(dir);
    }
  }
  return Arr.sort(Arr.fromIterable(dirs), deepestFirst);
};

/**
 * Removes the folders between each of `files` (gone by now) and `root` that are left empty, deepest first: shard
 * subfolders, a repository's, its organization's. A folder that still holds something (or can no longer be read) is
 * kept; `root` (the models folder) never goes. The removal is `rmdir`, which the system refuses for a folder that is
 * not empty: one a download fills in the meantime is kept, with what it holds (a check then a recursive removal could
 * delete a file written in between).
 */
export const removeEmptyFolders = Effect.fn('models.removeEmptyFolders')(function* (
  root: string,
  files: ReadonlyArray<string>,
) {
  const paths = yield* Path.Path;
  yield* Effect.forEach(
    foldersUnder(paths, root, files),
    (dir) => Effect.promise(() => rmdir(dir).catch(() => undefined)),
    { discard: true },
  );
});

/**
 * Deletes a model the scan found: refused (409) while it is used (`blocked`); then its files (a link: the link only),
 * then the folders left empty up to `root`, then, with `deleteProfiles`, the profiles that open it (and the default
 * profile setting when it named one of them). A file that cannot be removed is a defect (500): the profiles are kept,
 * which the other order could leave deleted for a model still on disk.
 */
export const deleteModel = Effect.fn('models.deleteModel')(function* (options: {
  readonly entry: ModelEntry;
  readonly root: string;
  readonly deleteProfiles: boolean;
}): Effect.fn.Return<
  ModelDeleted,
  ModelInUse | ProfileRunning,
  ProfilesRepo | SettingsRepo | Supervisor | BenchRunner | ActiveWrites | FileSystem.FileSystem | Path.Path
> {
  const { entry, root, deleteProfiles } = options;
  const fs = yield* FileSystem.FileSystem;
  const usage = yield* modelUsage(entry);
  if (usage.blocked !== null) return yield* ModelInUse.make({ message: usage.blocked });

  yield* Effect.forEach(entry.files, (file) => Effect.orDie(fs.remove(file, { force: true })), { discard: true });
  yield* removeEmptyFolders(root, entry.files);

  const ids = deleteProfiles ? Arr.map(usage.profiles, (profile) => profile.id) : [];
  // A profile deleted meanwhile is gone all the same.
  yield* Effect.forEach(ids, (id) => removeProfile(id).pipe(Effect.catchTag('ProfileNotFound', () => Effect.void)), {
    discard: true,
  });
  return { deletedFiles: entry.files, deletedProfiles: ids };
});
