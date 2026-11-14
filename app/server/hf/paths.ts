import { HfInvalidPath } from '@llama-webui/shared';
import { Array as Arr, Effect, FileSystem, Option, String as Str } from 'effect';
import { dual } from 'effect/Function';

/** `dir` without its trailing slashes (`/` stays `/`). */
const trimmed = (dir: string): string => (dir.length > 1 ? Str.replace(/\/+$/, '')(dir) : dir);

/**
 * The local folder of a repository's downloads: `<modelsDir>/<org>/<name>`. `repo` is already checked by
 * `HF_REPO_RE` (no `..`, no slash but the one between its two parts).
 */
export const repoDir: {
  (repo: string): (modelsDir: string) => string;
  (modelsDir: string, repo: string): string;
} = dual(2, (modelsDir: string, repo: string): string => `${trimmed(modelsDir)}/${repo}`);

/** The segments of a relative path once `.` and `..` are resolved; none when a `..` would leave its folder. */
const normalized = (path: string): Option.Option<ReadonlyArray<string>> =>
  Arr.reduce(
    Arr.filter(Str.split(path, '/'), (part) => part !== '' && part !== '.'),
    Option.some<ReadonlyArray<string>>([]),
    (acc, part) =>
      Option.flatMap(acc, (parts) =>
        part === '..'
          ? Arr.isReadonlyArrayNonEmpty(parts)
            ? Option.some(Arr.initNonEmpty(parts))
            : Option.none()
          : Option.some(Arr.append(parts, part)),
      ),
  );

/**
 * Where a file of the repository goes: under `dir`, never outside it (an absolute path, or one whose `..` would leave
 * the folder or that names the folder itself, is refused).
 */
export const fileDest: {
  (path: string): (dir: string) => Effect.Effect<string, HfInvalidPath>;
  (dir: string, path: string): Effect.Effect<string, HfInvalidPath>;
} = dual(2, (dir: string, path: string): Effect.Effect<string, HfInvalidPath> => {
  const parts = Str.startsWith('/')(path) ? Option.none() : normalized(path);
  return Option.match(Option.filter(parts, Arr.isReadonlyArrayNonEmpty), {
    onNone: () => Effect.fail(HfInvalidPath.make({ message: `Invalid file path in the repository: ${path}` })),
    onSome: (segments) => Effect.succeed(`${trimmed(dir)}/${Arr.join(segments, '/')}`),
  });
});

/** The temporary file of a download in progress (the models scan keeps only `*.gguf`: it never lists one). */
export const partPath = (dest: string): string => `${dest}.part`;

/** The size of a file; none when there is no file there (or it cannot be read). */
export const sizeOf = Effect.fn('paths.sizeOf')(function* (path: string) {
  const fs = yield* FileSystem.FileSystem;
  const info = yield* Effect.option(fs.stat(path));
  return Option.map(
    Option.filter(info, (stat) => stat.type === 'File'),
    (stat) => Number(stat.size),
  );
});
