import { Config, Effect, FileSystem, Option, Path, String as Str } from 'effect';

/** The separator of `PATH` (the app runs on Linux). */
const DELIMITER = ':';

/** Any of the execute bits. */
const EXECUTE = 0o111;

/**
 * Whether `file` is a regular file with an execute bit (a directory is not a binary). `FileSystem.access` checks
 * existence, read and write, not execution: the mode stands for it.
 */
const isExecutable = Effect.fn('which.isExecutable')(function* (file: string) {
  const fs = yield* FileSystem.FileSystem;
  const info = yield* fs.stat(file).pipe(Effect.option);
  return Option.exists(info, (i) => i.type === 'File' && (i.mode & EXECUTE) !== 0);
});

/** The file of the binary `name`: itself when it holds a `/`, else the first match in `PATH`. */
export const which = Effect.fn('which')(function* (name: string) {
  const path = yield* Path.Path;
  if (Str.includes('/')(name)) {
    const found = yield* isExecutable(name);
    return found ? Option.some(name) : Option.none<string>();
  }
  const dirs = yield* Config.String('PATH').pipe(Config.withDefault(''), Effect.orDie);
  for (const dir of Str.split(dirs, DELIMITER)) {
    if (dir === '') continue;
    const file = path.join(dir, name);
    if (yield* isExecutable(file)) return Option.some(file);
  }
  return Option.none<string>();
});
