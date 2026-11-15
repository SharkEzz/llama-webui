// @effect-diagnostics-next-line nodeBuiltinImport:off FileSystem of effect has no statfs: the free space comes from node:fs
import { statfs } from 'node:fs/promises';
import { Effect, Option, Path } from 'effect';

/** The free space of one existing folder; none when it cannot be read (it does not exist, or is not a folder). */
const statFree = (dir: string): Effect.Effect<Option.Option<number>> =>
  Effect.promise(() =>
    statfs(dir).then(
      (stats) => Option.some(Number(stats.bavail) * Number(stats.bsize)),
      () => Option.none(),
    ),
  );

/**
 * The bytes a user may still write to the disk of `dir`: those of its nearest existing parent when the folder is not
 * there yet (a repository's folder is created by its first file); null when no parent can be read, the root included.
 */
export const freeBytesOf = Effect.fn('freeSpace.freeBytesOf')(function* (dir: string) {
  const path = yield* Path.Path;
  let current = path.resolve(dir);
  while (true) {
    const free = yield* statFree(current);
    if (Option.isSome(free)) return free.value;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
});
