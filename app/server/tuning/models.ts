import { ModelNotFound, ModelPathInvalid, ModelUnreadable, ProjectorNotFound } from '@llama-webui/shared';
import { Effect, FileSystem, Option, String as Str } from 'effect';
import { GgufReader } from '../models/GgufReader.ts';
import type { ModelInfo } from '../models/gguf.ts';

/** Whether `path` is a regular file (a directory, a missing path and an unreadable one are not). */
const isFile = Effect.fn('tuning.isFile')(function* (path: string) {
  const fs = yield* FileSystem.FileSystem;
  const info = yield* Effect.option(fs.stat(path));
  return Option.exists(info, (i) => i.type === 'File');
});

/** The form of a model path: an absolute path to a `.gguf` file (400 otherwise). */
export const checkPathForm = (path: string): Effect.Effect<void, ModelPathInvalid> =>
  Str.startsWith('/')(path) && Str.endsWith('.gguf')(path)
    ? Effect.void
    : Effect.fail(ModelPathInvalid.make({ message: 'Expected an absolute path to a .gguf file' }));

/**
 * The GGUF the tuning plans on: an absolute path to a `.gguf` file (400 otherwise), an existing file (404), a readable
 * header (422 with the reader's message). Where the path may be is the caller's (`checkModelPath`): the launchpad reads
 * the profiles' models.
 */
export const loadModel = Effect.fn('tuning.loadModel')(function* (
  path: string,
): Effect.fn.Return<ModelInfo, ModelPathInvalid | ModelNotFound | ModelUnreadable, GgufReader | FileSystem.FileSystem> {
  yield* checkPathForm(path);
  if (!(yield* isFile(path))) return yield* ModelNotFound.make({ message: 'Model not found' });
  const reader = yield* GgufReader;
  return yield* reader.read(path).pipe(Effect.mapError((error) => ModelUnreadable.make({ message: error.message })));
});

/** The size of the projector at `path`: 0 without one, 404 when it is not a file. */
export const mmprojBytes = Effect.fn('tuning.mmprojBytes')(function* (
  path: string | null | undefined,
): Effect.fn.Return<number, ProjectorNotFound, FileSystem.FileSystem> {
  if (path === null || path === undefined || path === '') return 0;
  const fs = yield* FileSystem.FileSystem;
  const info = yield* Effect.option(fs.stat(path));
  if (Option.isNone(info) || info.value.type !== 'File') {
    return yield* ProjectorNotFound.make({ message: 'Projector not found' });
  }
  return Number(info.value.size);
});
