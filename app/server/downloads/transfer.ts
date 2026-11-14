import type { DownloadFile, DownloadItem, DownloadLive } from '@llama-webui/shared';
import {
  Array as Arr,
  Clock,
  Duration,
  Effect,
  FileSystem,
  Option,
  Path,
  type PlatformError,
  Predicate,
  Ref,
  Schema,
  type Scope,
  String as Str,
  Stream,
} from 'effect';
import { dual } from 'effect/Function';
import { HttpClientRequest, type HttpClientResponse } from 'effect/http';
import { type HubError, hubError, reasonOf } from '../hf/HfClient.ts';
import { HfHttp } from '../hf/HfHttp.ts';
import { fileDest, partPath, sizeOf } from '../hf/paths.ts';
import { hfEndpoint, hfToken, hubHeaders } from '../hf/token.ts';
import { DownloadsRepo } from './DownloadsRepo.ts';
import { type Sha256, sha256 } from './hash.ts';

const MiB = 1024 * 1024;

/** How many redirects an attempt follows (the Hub's `resolve` answers one, to the CDN): the next one fails it. */
const MAX_REDIRECTS = 6;

/** What a transfer tells of its progress: the phase, the file it is on, the bytes of the item written so far. */
export interface TransferProgress {
  readonly phase: DownloadLive['phase'];
  /** The file being written (its path in the repository). */
  readonly file: string;
  /** The bytes of the item written so far, the files done included. */
  readonly bytesDone: number;
  /** When the next attempt starts (`retrying`); null otherwise. */
  readonly retryAt: number | null;
  /**
   * The progress of a chunk written: published at most every `liveEvery`, the bytes per second measured on it. The
   * others (an attempt or an answer that starts, `verifying`, `retrying`) are published at once.
   */
  readonly throttled: boolean;
}

/** Why a transfer gave up: the item is saved `error` with its message and code; `status` is the HTTP one it maps to. */
export class TransferFailed extends Schema.TaggedError<TransferFailed, { readonly TransferFailed: unique symbol }>()(
  'TransferFailed',
  { message: Schema.String, code: Schema.String, status: Schema.Int },
) {}

/**
 * Writes the files of an item not done yet, each marked done (`DownloadsRepo.fileDone`) once in place, and tells its
 * progress through `report`. The queue interrupts it when the item is canceled or the app stops: it keeps the `.part`
 * of the file it was on (the queue deletes it on a cancel; the next start resumes it after a stop).
 */
export type Transfer = (
  item: DownloadItem,
  report: (progress: TransferProgress) => Effect.Effect<void>,
) => Effect.Effect<void, TransferFailed, HfHttp | FileSystem.FileSystem | Path.Path | DownloadsRepo>;

/** An attempt that failed in a way the next one may not: the network, the Hub's 408, 429 and 5xx, a body gone wrong. */
class Retryable extends Schema.TaggedError<Retryable, { readonly Retryable: unique symbol }>()('Retryable', {
  message: Schema.String,
}) {}

/** The sha256 of the first `bytes` bytes of the `.part` of `path`. */
interface HashState {
  readonly path: string;
  hasher: Sha256;
  bytes: number;
}

const isEnospc = (error: PlatformError.PlatformError): boolean => {
  const cause = error.reason.cause;
  return Predicate.hasProperty(cause, 'code') && cause.code === 'ENOSPC';
};

const diskFull = (): TransferFailed => TransferFailed.make({ message: 'Disk full', code: 'disk-full', status: 507 });

/** A file operation that failed outside the writes: the disk being full, else the item fails with the error. */
const localFailure = (error: PlatformError.PlatformError): TransferFailed =>
  isEnospc(error) ? diskFull() : TransferFailed.make({ message: error.message, code: 'download-failed', status: 500 });

/** A write that failed: the disk being full ends the item, any other error the attempt. */
const writeFailure = (error: PlatformError.PlatformError): TransferFailed | Retryable =>
  isEnospc(error) ? diskFull() : Retryable.make({ message: error.message });

const unreachable = (reason: string): Retryable => Retryable.make({ message: `Hugging Face unreachable: ${reason}` });

/** The Hub's refusal of a download, with the code the item is saved with. */
const refused = (error: HubError): TransferFailed => {
  switch (error._tag) {
    case 'HfGated':
      return TransferFailed.make({ message: error.message, code: 'hf-gated', status: 403 });
    case 'HfNotFound':
      return TransferFailed.make({ message: error.message, code: 'hf-not-found', status: 404 });
    case 'HfUnauthorized':
      return TransferFailed.make({ message: error.message, code: 'hf-unauthorized', status: 401 });
    case 'HfRateLimited':
      return TransferFailed.make({ message: error.message, code: 'hf-rate-limited', status: 429 });
    case 'HfUnreachable':
      return TransferFailed.make({ message: error.message, code: 'hf-unreachable', status: 502 });
  }
};

/** The size of the files done. */
const doneBytes = (files: ReadonlyArray<DownloadFile>) =>
  Arr.reduce(files, 0, (sum, file) => (file.done ? sum + file.size : sum));

/**
 * The transfer: each file from `<endpoint>/<repo>/resolve/<revision>/<path>` through `HfHttp`, its redirects followed
 * by hand (6 at most, the token only to the endpoint's origin, never to the CDN), into its `.part` (resumed with a
 * `Range` request), hashed as it is written, then checked (size, sha256) and renamed into place. An attempt that
 * fails in a transient way (network, 408, 429, 5xx, `stall` without data, a body or a range gone wrong) is logged and
 * started again after the next of `retryDelays` (published `retrying`), the budget reset after an attempt that
 * received data; once spent, the item fails with 502 and the last message.
 */
export const transferWith = (options: {
  readonly retryDelays: ReadonlyArray<Duration.Input>;
  readonly stall: Duration.Input;
}): Transfer => {
  const delays = Arr.map(options.retryDelays, (delay) => Duration.toMillis(Duration.fromInputUnsafe(delay)));
  const stall = Duration.fromInputUnsafe(options.stall);
  const noData = () => Retryable.make({ message: `no data for ${Math.round(Duration.toMillis(stall) / 1000)} s` });

  return (item, report) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const http = yield* HfHttp;
      const repo = yield* DownloadsRepo;
      /** The hash of the last attempt, reused by the next one when it covers exactly its `.part`. */
      const kept = yield* Ref.make<Option.Option<HashState>>(Option.none());
      /** The attempt running wrote data: the retry budget starts again. */
      const progressed = yield* Ref.make(false);

      const sizeAt = (file: string) => sizeOf(file).pipe(Effect.provideService(FileSystem.FileSystem, fs));
      const remove = (file: string) => fs.remove(file, { force: true }).pipe(Effect.mapError(localFailure));
      const downloading = (file: DownloadFile, bytesDone: number, throttled: boolean) =>
        report({ phase: 'downloading', file: file.path, bytesDone, retryAt: null, throttled });

      /**
       * The hash of the first `offset` bytes of `part`: the last attempt's when it covers exactly them, else read again
       * from the disk in 1 MiB chunks (`verifying`: after a restart, or a write that failed half-way).
       */
      const hashOf = (file: DownloadFile, part: string, offset: number, base: number) =>
        Effect.gen(function* () {
          const last = yield* Ref.get(kept);
          if (Option.isSome(last) && last.value.path === file.path && last.value.bytes === offset) return last.value;
          yield* Ref.set(kept, Option.none());
          const hash: HashState = { path: file.path, hasher: sha256(), bytes: 0 };
          if (offset > 0) {
            yield* report({
              phase: 'verifying',
              file: file.path,
              bytesDone: base + offset,
              retryAt: null,
              throttled: false,
            });
            yield* fs.stream(part, { chunkSize: MiB, bytesToRead: offset }).pipe(
              Stream.runForEach((chunk) =>
                Effect.sync(() => {
                  hash.hasher.update(chunk);
                  hash.bytes += chunk.byteLength;
                }),
              ),
              Effect.mapError(localFailure),
            );
          }
          yield* Ref.set(kept, Option.some(hash));
          return hash;
        });

      /**
       * The GET of `file` from `offset`, its redirects followed: the answer when it is 200 or 206. A 416 deletes the
       * `.part`; the Hub's 408, 429 and 5xx are transient, its other errors end the item.
       */
      const request = (
        file: DownloadFile,
        part: string,
        offset: number,
      ): Effect.Effect<HttpClientResponse.HttpClientResponse, Retryable | TransferFailed, Scope.Scope> =>
        Effect.gen(function* () {
          const { token } = yield* hfToken.pipe(Effect.provideService(FileSystem.FileSystem, fs));
          const endpoint = yield* hfEndpoint;
          const origin = Option.map(Option.fromNullishOr(URL.parse(endpoint)), (url) => url.origin);
          const range: Record<string, string> = offset > 0 ? { range: `bytes=${offset}-` } : {};
          const segments = Arr.join(Arr.map(Str.split(file.path, '/'), encodeURIComponent), '/');
          let url = `${endpoint}/${item.repo}/resolve/${item.revision}/${segments}`;
          for (let hops = 0; ; hops++) {
            const onEndpoint = Option.exists(origin, (o) => URL.parse(url)?.origin === o);
            const headers = { ...hubHeaders(onEndpoint ? token : null), ...range };
            const response = yield* http
              .execute(HttpClientRequest.get(url, { headers }))
              .pipe(Effect.mapError((error) => error.pipe(reasonOf, unreachable)));
            const location = response.headers.location;
            if (response.status >= 300 && response.status < 400 && location !== undefined) {
              if (hops === MAX_REDIRECTS) {
                return yield* TransferFailed.make({
                  message: 'Too many redirects from Hugging Face',
                  code: 'hf-unreachable',
                  status: 502,
                });
              }
              const next = URL.parse(location, url);
              if (next === null) return yield* unreachable(`invalid redirect to ${location}`);
              url = next.href;
              continue;
            }
            if (response.status === 200 || response.status === 206) return response;
            if (response.status === 416) {
              yield* remove(part);
              return yield* Retryable.make({ message: `${file.path}: range not satisfiable` });
            }
            const error = hubError(response, { repo: item.repo, hasToken: token !== null });
            if (response.status === 408 || response.status === 429 || response.status >= 500) {
              return yield* Retryable.make({ message: error.message });
            }
            return yield* refused(error);
          }
        });

      /** The body of `file` from `offset`, appended to `part` (or written from zero) and to `hash`, which follows it. */
      const receive = (
        file: DownloadFile,
        part: string,
        offset: number,
        hash: Option.Option<HashState>,
        base: number,
      ): Effect.Effect<void, Retryable | TransferFailed, Scope.Scope> =>
        Effect.gen(function* () {
          const response = yield* request(file, part, offset).pipe(
            Effect.timeoutOrElse({ duration: stall, orElse: () => Effect.fail(noData()) }),
          );
          let start = offset;
          if (response.status === 206) {
            const range = /^bytes (\d+)-/.exec(response.headers['content-range'] ?? '');
            if (range === null || Number(range[1]) !== offset) {
              yield* remove(part);
              return yield* Retryable.make({ message: `${file.path}: unexpected range in the response` });
            }
          } else if (offset > 0) {
            // The server ignored the Range header: from zero.
            start = 0;
            if (Option.isSome(hash)) {
              hash.value.hasher = sha256();
              hash.value.bytes = 0;
            }
          }
          const handle = yield* fs.open(part, { flag: start > 0 ? 'a' : 'w' }).pipe(Effect.mapError(writeFailure));
          let written = start;
          yield* downloading(file, base + written, false);
          yield* response.stream.pipe(
            Stream.mapError((error) => error.pipe(reasonOf, unreachable)),
            Stream.timeoutOrElse({ duration: stall, orElse: () => Stream.fail(noData()) }),
            Stream.runForEach((chunk) =>
              Effect.gen(function* () {
                // Written first: a chunk that did not land on the disk is not hashed.
                yield* handle.writeAll(chunk).pipe(Effect.mapError(writeFailure));
                if (Option.isSome(hash)) {
                  hash.value.hasher.update(chunk);
                  hash.value.bytes += chunk.byteLength;
                }
                written += chunk.byteLength;
                yield* Ref.set(progressed, true);
                yield* downloading(file, base + written, true);
              }),
            ),
          );
        });

      /** One attempt at `file`: its `.part` resumed, its size and sha256 checked, renamed into place. */
      const attempt = (file: DownloadFile, base: number): Effect.Effect<void, Retryable | TransferFailed> =>
        Effect.gen(function* () {
          // Checked when the variant was read from the Hub: a path that leaves the folder never gets here.
          const dest = yield* Effect.orDie(fileDest(item.dir, file.path));
          const part = partPath(dest);
          // Already in place: a stop between the rename and the row that records it.
          const placed = yield* sizeAt(dest);
          if (Option.contains(placed, file.size)) return;
          yield* fs.makeDirectory(path.dirname(dest), { recursive: true }).pipe(Effect.mapError(localFailure));
          const found = yield* sizeAt(part);
          let offset = Option.getOrElse(found, () => 0);
          if (offset > file.size) {
            yield* remove(part);
            offset = 0;
          }
          yield* downloading(file, base + offset, false);
          const hash =
            file.sha256 === null ? Option.none<HashState>() : yield* Effect.asSome(hashOf(file, part, offset, base));
          if (offset < file.size) yield* Effect.scoped(receive(file, part, offset, hash, base));
          const got = yield* sizeAt(part);
          const size = Option.getOrElse(got, () => 0);
          if (size !== file.size) {
            // Short (the body ended early): kept and resumed. Too long: it cannot be this file.
            if (size > file.size) yield* remove(part);
            return yield* Retryable.make({ message: `${file.path}: got ${size} of ${file.size} bytes` });
          }
          yield* Ref.set(kept, Option.none());
          if (Option.isSome(hash) && hash.value.hasher.hex() !== file.sha256) {
            yield* remove(part);
            return yield* TransferFailed.make({
              message: `Checksum mismatch for ${file.path}: the file was deleted`,
              code: 'checksum-mismatch',
              status: 422,
            });
          }
          yield* fs.rename(part, dest).pipe(Effect.mapError(localFailure));
        });

      /** The attempts at `file`, a transient failure logged, published `retrying` and paused for before the next. */
      const withRetries = (file: DownloadFile, base: number) =>
        Effect.gen(function* () {
          let failures = 0;
          while (true) {
            yield* Ref.set(progressed, false);
            const failure = yield* attempt(file, base).pipe(
              Effect.as(Option.none<Retryable>()),
              Effect.catchTag('Retryable', Effect.succeedSome),
            );
            if (Option.isNone(failure)) return;
            const { message } = failure.value;
            if (yield* Ref.get(progressed)) failures = 0;
            const delay = Arr.get(delays, failures);
            failures++;
            if (Option.isNone(delay)) {
              return yield* TransferFailed.make({ message, code: 'hf-unreachable', status: 502 });
            }
            yield* Effect.logWarning(`[llama-webui] download ${item.repo}/${file.path}: ${message}, retrying`);
            const now = yield* Clock.currentTimeMillis;
            const dest = yield* Effect.orDie(fileDest(item.dir, file.path));
            const part = yield* sizeAt(partPath(dest));
            const bytesDone =
              base +
              Math.min(
                Option.getOrElse(part, () => 0),
                file.size,
              );
            yield* report({
              phase: 'retrying',
              file: file.path,
              bytesDone,
              retryAt: now + delay.value,
              throttled: false,
            });
            yield* Effect.sleep(Duration.millis(delay.value));
          }
        });

      let current = item;
      for (const file of item.files) {
        if (file.done) continue;
        yield* withRetries(file, doneBytes(current.files));
        current = yield* repo.fileDone(item.id, file.path);
      }
    }).pipe(Effect.withSpan('transfer.item', { attributes: { repo: item.repo, key: item.key } }));
};

/** The transfer of the app: attempts after 2, 4, 8, 16 and 30 s, started again after 60 s without data. */
export const transferItem: {
  (report: (progress: TransferProgress) => Effect.Effect<void>): (item: DownloadItem) => ReturnType<Transfer>;
  (item: DownloadItem, report: (progress: TransferProgress) => Effect.Effect<void>): ReturnType<Transfer>;
} = dual(
  2,
  transferWith({
    retryDelays: ['2 seconds', '4 seconds', '8 seconds', '16 seconds', '30 seconds'],
    stall: '60 seconds',
  }),
);
