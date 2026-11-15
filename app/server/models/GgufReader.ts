import { gguf, ggufAllShards, parseGgufShardFilename } from '@huggingface/gguf';
import {
  Array as Arr,
  Cache,
  Context,
  Duration,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Option,
  type PlatformError,
  Predicate,
} from 'effect';
import { type ModelInfo, ModelReadError, type ParsedShard, parseModel, shardFiles } from './gguf.ts';

/** The parsed models kept (each holds its tensor table). */
const CAPACITY = 8;

/** The errno of a failed file system call (`ENOENT`…), kept by the platform as the error's cause. */
const errnoOf = (error: PlatformError.PlatformError): Option.Option<string> => {
  const cause = error.reason.cause;
  return Predicate.hasProperty(cause, 'code') && Predicate.isString(cause.code)
    ? Option.some(cause.code)
    : Option.none();
};

/** A failed `stat` of `path`, in the Nitro server's words. */
const statFailure =
  (path: string) =>
  (error: PlatformError.PlatformError): ModelReadError => {
    const code = errnoOf(error);
    const message = Option.match(code, {
      onNone: () => `${error.message}: ${path}`,
      onSome: (errno) =>
        errno === 'ENOENT' || errno === 'ENOTDIR'
          ? `file not found: ${path}`
          : errno === 'EACCES' || errno === 'EPERM'
            ? `permission denied: ${path}`
            : `${errno}: ${path}`,
    });
    return ModelReadError.make({ message });
  };

/** The stamp of a model's parts: `<mtime ms>:<size>` of each, joined by `|`. */
export const stampOf = (parts: ReadonlyArray<FileSystem.File.Info>): string =>
  Arr.join(
    Arr.map(parts, (info) => {
      const mtime = Option.match(info.mtime, { onNone: () => 0, onSome: (date) => date.getTime() });
      return `${mtime}:${Number(info.size)}`;
    }),
    '|',
  );

/** A failed parse, in the Nitro server's words. */
const unreadable = (error: unknown): ModelReadError =>
  ModelReadError.make({
    message: `unreadable GGUF: ${Predicate.hasProperty(error, 'message') && Predicate.isString(error.message) ? error.message : String(error)}`,
  });

/** The parts of a GGUF as `@huggingface/gguf` parses them, and its parameter count. */
const parse = (
  path: string,
): Effect.Effect<{ readonly shards: ReadonlyArray<ParsedShard>; readonly parameterCount: number }, ModelReadError> =>
  parseGgufShardFilename(path) === null
    ? Effect.tryPromise({
        try: () => gguf(path, { allowLocalFile: true, computeParametersCount: true }),
        catch: unreadable,
      }).pipe(Effect.map((one) => ({ shards: [one], parameterCount: one.parameterCount })))
    : Effect.tryPromise({ try: () => ggufAllShards(path, { allowLocalFile: true }), catch: unreadable });

/** The GGUFs read whole: their metadata and tensors, the last 8 kept while no part changes. */
export class GgufReader extends Context.Service<
  GgufReader,
  {
    /**
     * The model at `path` (all its parts when the name is `-00001-of-0000N.gguf`). A model read before is given back
     * while the stamp of its parts is the same; a failed read is not kept.
     */
    readonly read: (path: string) => Effect.Effect<ModelInfo, ModelReadError>;
    /** The stamp of every part of the model at `path` (see `stampOf`). */
    readonly stamp: (path: string) => Effect.Effect<string, ModelReadError>;
  }
>()('@llama-webui/app/server/models/GgufReader') {
  static readonly layer: Layer.Layer<GgufReader, never, FileSystem.FileSystem> = Layer.effect(
    GgufReader,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;

      /** The `stat` of each part, in order; the first that fails names its file. */
      const statParts = (files: ReadonlyArray<string>) =>
        Effect.forEach(files, (file) => fs.stat(file).pipe(Effect.mapError(statFailure(file))));

      const stamp = Effect.fn('GgufReader.stamp')(function* (path: string) {
        const parts = yield* statParts(shardFiles(path));
        return stampOf(parts);
      });

      const load = Effect.fn('GgufReader.load')(function* (path: string) {
        const files = shardFiles(path);
        const parts = yield* statParts(files);
        const { shards, parameterCount } = yield* parse(path);
        const sizes = Arr.map(parts, (info) => Number(info.size));
        const model: ModelInfo = { ...parseModel({ path, shards, fileSizes: sizes, parameterCount }), files };
        return { stamp: stampOf(parts), model };
      });

      // A success stays until its stamp changes or 8 others push it out; a failure is not kept.
      const cache = yield* Cache.makeWith(load, {
        capacity: CAPACITY,
        timeToLive: (exit) => (Exit.isSuccess(exit) ? Duration.infinity : Duration.zero),
      });

      const read = Effect.fn('GgufReader.read')(function* (path: string) {
        const current = yield* stamp(path);
        yield* Cache.invalidateWhen(cache, path, (entry) => entry.stamp !== current);
        const entry = yield* Cache.get(cache, path);
        return entry.model;
      });

      return GgufReader.of({ read, stamp });
    }),
  );
}
