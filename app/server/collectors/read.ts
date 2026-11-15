import { Effect, FileSystem, String as Str } from 'effect';

/** The text of a file, null when it cannot be read (a missing file, a process that is gone, no permission). */
export const readText = (file: string): Effect.Effect<string | null, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* fs.readFileString(file).pipe(Effect.orElseSucceed(() => null));
  });

/** The trimmed text of a file (a sysfs or procfs attribute), null when it cannot be read. */
export const readTrimmed = (file: string): Effect.Effect<string | null, never, FileSystem.FileSystem> =>
  Effect.map(readText(file), (text) => (text === null ? null : Str.trim(text)));
