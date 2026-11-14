import { Effect, FileSystem } from 'effect';

/** The text of a file, null when it cannot be read (a missing file, a process that is gone, no permission). */
export const readText = (file: string): Effect.Effect<string | null, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* fs.readFileString(file).pipe(Effect.orElseSucceed(() => null));
  });
