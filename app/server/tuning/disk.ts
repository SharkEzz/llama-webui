import { type DiskSpeed, FileTooSmall, MiB, ModelFileNotFound } from '@llama-webui/shared';
import { Clock, Effect, FileSystem, Option, Random, Stream } from 'effect';
import type { PlatformError } from 'effect/PlatformError';

/** The most a measure reads: enough to get past the disk's own cache. */
const MAX_BYTES = 1024 * MiB;
/** Below this, the measure says nothing about the disk. */
const MIN_BYTES = 64 * MiB;
const CHUNK = MiB;

/** The bytes `[start, end)` of `path`, read in 1 MiB chunks; fails when the file cannot be read. */
export const fileRange = (options: {
  readonly path: string;
  readonly start: number;
  readonly end: number;
}): Stream.Stream<Uint8Array, PlatformError, FileSystem.FileSystem> =>
  Stream.unwrap(
    Effect.map(FileSystem.FileSystem, (fs) =>
      fs.stream(options.path, {
        offset: options.start,
        bytesToRead: Math.max(0, options.end - options.start),
        chunkSize: CHUNK,
      }),
    ),
  );

/**
 * The sequential read bandwidth of the disk holding `path`: up to 1 GiB (the whole file when smaller) read from some
 * point of the file (random by default, to miss its already cached start), timed with the `Clock`. A missing path or
 * a directory is a 404, a file under 64 MiB a 400. The OS page cache can still inflate the measure.
 */
export const measureDiskSpeed = Effect.fn('tuning.measureDiskSpeed')(function* (options: {
  readonly path: string;
  readonly offsetFraction?: number;
}): Effect.fn.Return<DiskSpeed, ModelFileNotFound | FileTooSmall, FileSystem.FileSystem> {
  const { path } = options;
  const fs = yield* FileSystem.FileSystem;
  // One stat for both the check and the size: the file can go away between two (a download renamed, a deletion).
  const info = yield* Effect.option(fs.stat(path));
  if (Option.isNone(info) || info.value.type !== 'File') {
    return yield* ModelFileNotFound.make({ message: `File not found: ${path}` });
  }
  const size = Number(info.value.size);
  const bytes = Math.min(MAX_BYTES, size);
  if (bytes < MIN_BYTES) {
    return yield* FileTooSmall.make({ message: `File too small to measure (${Math.round(size / MiB)} MiB)` });
  }
  const fraction = options.offsetFraction ?? (yield* Random.next);
  const start = Math.floor((size - bytes) * fraction);
  const t0 = yield* Clock.currentTimeNanos;
  // A read that fails half way (the file went away) is a defect, as any I/O error under a request.
  const read = yield* fileRange({ path, start, end: start + bytes }).pipe(
    Stream.runFold(
      () => 0,
      (n, chunk) => n + chunk.byteLength,
    ),
    Effect.orDie,
  );
  const t1 = yield* Clock.currentTimeNanos;
  const seconds = Math.max(1e-6, Number(t1 - t0) / 1e9);
  const at = yield* Clock.currentTimeMillis;
  const speed: DiskSpeed = { bytesPerSec: read / seconds, sampledBytes: read, path, at };
  return speed;
});
