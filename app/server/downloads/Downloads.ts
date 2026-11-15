import {
  AlreadyQueued,
  DiskFull,
  type DownloadFile,
  type DownloadItem,
  type DownloadList,
  type DownloadLive,
  DownloadNotFound,
  isDownloadActive,
  NotFinished,
} from '@llama-webui/shared';
import {
  Array as Arr,
  Cause,
  Clock,
  Context,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Option,
  Path,
  Ref,
  Semaphore,
  SynchronizedRef,
} from 'effect';
import type { HfHttp } from '../hf/HfHttp.ts';
import { fileDest, partPath, sizeOf } from '../hf/paths.ts';
import type { NewDownload } from '../hf/repo.ts';
import { removeEmptyFolders } from '../models/usage.ts';
import { Shutdown } from '../runtime/Shutdown.ts';
import { WsHub } from '../ws/WsHub.ts';
import { DownloadsRepo } from './DownloadsRepo.ts';
import { freeBytesOf } from './freeSpace.ts';
import {
  RETRY_DELAYS,
  STALL,
  type Transfer,
  type TransferFailed,
  type TransferProgress,
  transferWith,
} from './transfer.ts';

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;

/** A size as the disk space refusal writes it: GiB with one decimal from 1 GiB, whole MiB below. */
const fmtBytes = (n: number): string => (n >= GiB ? `${(n / GiB).toFixed(1)} GiB` : `${Math.round(n / MiB)} MiB`);

/** The item the queue runs now. */
interface Running {
  readonly id: number;
  /** Completed by `remove`: the loop interrupts the transfer, then deletes what it wrote. */
  readonly canceled: Deferred.Deferred<void>;
  /** What `download-progress` last published. */
  readonly live: DownloadLive;
  /** When the bytes per second were last measured, and the bytes written then. */
  readonly lastEmit: number;
  readonly lastBytes: number;
}

/** What the queue's lock guards: the loop's fiber while one runs, the item it runs. */
interface State {
  readonly loop: Option.Option<Fiber.Fiber<void>>;
  readonly running: Option.Option<Running>;
}

/** How a transfer ended, for the item's status. */
type Outcome =
  | { readonly _tag: 'done' }
  | { readonly _tag: 'canceled' }
  | {
      readonly _tag: 'error';
      readonly message: string;
      readonly code: string;
      /** The cause of a defect, logged with the failure. */
      readonly defect: Option.Option<Cause.Cause<unknown>>;
    };

const outcomeOf = (exit: Exit.Exit<void, TransferFailed>): Outcome => {
  if (Exit.isSuccess(exit)) return { _tag: 'done' };
  const failure = Cause.findErrorOption(exit.cause);
  if (Option.isSome(failure)) {
    return { _tag: 'error', message: failure.value.message, code: failure.value.code, defect: Option.none() };
  }
  const squashed = Cause.squash(exit.cause);
  const message = squashed instanceof Error ? squashed.message : String(squashed);
  return { _tag: 'error', message, code: 'download-failed', defect: Option.some(exit.cause) };
};

/** The size of the files done. */
const doneBytes = (files: ReadonlyArray<DownloadFile>) =>
  Arr.reduce(files, 0, (sum, file) => (file.done ? sum + file.size : sum));

const alreadyQueued = (name: string) => AlreadyQueued.make({ message: `${name} is already in the download queue` });

/**
 * The Hugging Face download queue, in the `downloads` table: one item at a time, the next one an item left
 * `downloading` (a stop, a restart) first, then the oldest queued. Each status change is published `download`, the
 * live progress of the running item `download-progress` (null once it ends), a removal `download-deleted`.
 */
export class Downloads extends Context.Service<
  Downloads,
  {
    /** Every item, oldest first, and the live progress of the one running. */
    readonly list: Effect.Effect<DownloadList>;
    /**
     * Queues variants. Files already in place (same size) are left out, a variant with nothing left is skipped (no
     * row); a variant already in the queue (or named twice) is refused, and so is a total the disk cannot take.
     */
    readonly enqueue: (
      inputs: ReadonlyArray<NewDownload>,
    ) => Effect.Effect<ReadonlyArray<DownloadItem>, AlreadyQueued | DiskFull>;
    /** Puts a failed or canceled item back in the queue; its files are checked on disk again when it runs. */
    readonly retry: (
      id: number,
    ) => Effect.Effect<DownloadItem, DownloadNotFound | NotFinished | AlreadyQueued | DiskFull>;
    /**
     * A running item is canceled (its transfer stopped, then what it wrote deleted), a queued one canceled at once
     * (its files deleted: a deletion that fails dies once the item is saved and published `canceled`), any other taken
     * out of the list with its files kept.
     */
    readonly remove: (id: number) => Effect.Effect<void, DownloadNotFound>;
    /** Takes the finished items (done, error, canceled) out of the list, their files kept; how many. */
    readonly clear: Effect.Effect<number>;
  }
>()('@llama-webui/app/server/downloads/Downloads') {
  /**
   * The queue: `freeBytes` tells the free space of a folder's disk (null: unknown, not checked), `marginBytes` is
   * left free on top of the downloads; `retryDelays` and `stall` are the transfer's (the pauses between attempts after
   * a network error, the time without data after which an attempt starts again), `liveEvery` the interval of the
   * progress messages; `transfer` replaces the real one (`transferWith`, on `retryDelays` and `stall`). The loop runs
   * in the layer's scope, started by the build (the items left from the last run), `enqueue` and `retry`. Its shutdown
   * step stops the transfer and writes nothing: the item stays `downloading`, its `.part` kept, and the next start
   * resumes it.
   */
  static readonly layerWith = (options: {
    readonly freeBytes?: (dir: string) => Effect.Effect<number | null>;
    readonly marginBytes?: number;
    readonly retryDelays?: ReadonlyArray<Duration.Input>;
    readonly stall?: Duration.Input;
    readonly liveEvery?: Duration.Input;
    readonly transfer?: Transfer;
  }): Layer.Layer<Downloads, never, DownloadsRepo | HfHttp | WsHub | FileSystem.FileSystem | Path.Path | Shutdown> =>
    Layer.effect(
      Downloads,
      Effect.gen(function* () {
        const repo = yield* DownloadsRepo;
        const hub = yield* WsHub;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const shutdown = yield* Shutdown;
        const context = yield* Effect.context<HfHttp | FileSystem.FileSystem | Path.Path | DownloadsRepo>();
        const scope = yield* Effect.scope;
        const freeBytes =
          options.freeBytes ?? ((dir: string) => freeBytesOf(dir).pipe(Effect.provideService(Path.Path, path)));
        const margin = options.marginBytes ?? GiB;
        const liveEveryMs = Duration.toMillis(Duration.fromInputUnsafe(options.liveEvery ?? '250 millis'));
        const transfer =
          options.transfer ??
          transferWith({ retryDelays: options.retryDelays ?? RETRY_DELAYS, stall: options.stall ?? STALL });

        const state = yield* SynchronizedRef.make<State>({ loop: Option.none(), running: Option.none() });
        /** Work was added since the loop last looked at the queue: a loop that stops on a failure starts again. */
        const dirty = yield* Ref.make(false);
        /** Set by the shutdown step under the lock: nothing is written or started after it. */
        const closing = yield* Ref.make(false);
        /** `enqueue` and `retry` one at a time: the already-queued and disk space checks see each other's rows. */
        const permits = yield* Semaphore.make(1);
        const serial = Semaphore.withPermits(permits, 1);

        const sizeAt = (file: string) => sizeOf(file).pipe(Effect.provideService(FileSystem.FileSystem, fs));

        const published = (item: DownloadItem) => hub.publish({ type: 'download', payload: item });
        const liveOf = (s: State) => Option.getOrNull(Option.map(s.running, (run) => run.live));

        /** Under the lock: the loop is due to look again, and starts unless it runs (or the app stops). */
        const kicked = (s: State): Effect.Effect<State> =>
          Effect.gen(function* () {
            yield* Ref.set(dirty, true);
            if (Option.isSome(s.loop) || (yield* Ref.get(closing))) return s;
            const fiber = yield* Effect.forkIn(loop, scope);
            return { ...s, loop: Option.some(fiber) };
          });

        /** The files of `files` not in place yet (same size), and the bytes they still need (a `.part` counts). */
        const remaining = Effect.fnUntraced(function* <F extends { readonly path: string; readonly size: number }>(
          dir: string,
          files: ReadonlyArray<F>,
        ) {
          const left: Array<F> = [];
          let bytes = 0;
          for (const file of files) {
            // Checked when the variant was read from the Hub: a path that leaves the folder never gets here.
            const dest = yield* Effect.orDie(fileDest(dir, file.path));
            const placed = yield* sizeAt(dest);
            if (Option.contains(placed, file.size)) continue;
            left.push(file);
            const part = yield* sizeAt(partPath(dest));
            bytes +=
              file.size -
              Math.min(
                Option.getOrElse(part, () => 0),
                file.size,
              );
          }
          return { files: left, bytes };
        });

        /** Refuses `need` bytes more when they do not fit next to what the queue still has to write. */
        const checkSpace = Effect.fnUntraced(function* (dir: string, need: number) {
          // What the queue ahead still has to write lands on the same disk most of the time.
          const active = yield* repo.active;
          const total =
            need + Arr.reduce(active, 0, (sum, item) => sum + Math.max(0, item.totalBytes - item.bytesDone));
          const free = yield* freeBytes(dir);
          if (free !== null && free < total + margin) {
            return yield* DiskFull.make({
              message: `Not enough disk space: ${fmtBytes(total)} to download (plus ${fmtBytes(margin)} margin), ${fmtBytes(free)} free`,
            });
          }
        });

        const refuseQueued = Effect.fnUntraced(function* (of: {
          readonly repo: string;
          readonly key: string;
          readonly name: string;
        }) {
          const active = yield* repo.active;
          if (Arr.some(active, (item) => item.repo === of.repo && item.key === of.key)) {
            return yield* alreadyQueued(of.name);
          }
        });

        /** Deletes what an item wrote: the `.part` files, the files it put in place, then the folders left empty. */
        const discard = Effect.fnUntraced(function* (item: DownloadItem) {
          const dests: Array<string> = [];
          for (const file of item.files) {
            const dest = yield* fileDest(item.dir, file.path);
            dests.push(dest);
            yield* fs.remove(partPath(dest), { force: true });
            const placed = yield* sizeAt(dest);
            if (file.done || Option.contains(placed, file.size)) yield* fs.remove(dest, { force: true });
          }
          // Up to the models folder, `<models>/<org>/<name>` being the item's.
          yield* removeEmptyFolders(path.dirname(path.dirname(item.dir)), dests).pipe(
            Effect.provideService(Path.Path, path),
          );
        });

        /** Under the lock: the next item, saved `downloading` and published, registered as running. */
        const pick = SynchronizedRef.modifyEffect(state, (s) =>
          Effect.gen(function* () {
            if (yield* Ref.get(closing)) return [Option.none(), s] as const;
            yield* Ref.set(dirty, false);
            const next = yield* repo.next;
            if (Option.isNone(next)) return [Option.none(), { loop: Option.none(), running: Option.none() }] as const;
            const start = next.value;
            const item = start.status === 'downloading' ? start : yield* repo.setStatus(start.id, 'downloading');
            const done = doneBytes(item.files);
            const live: DownloadLive = {
              id: item.id,
              phase: 'downloading',
              file: Option.getOrElse(
                Option.map(
                  Arr.findFirst(item.files, (file) => !file.done),
                  (file) => file.path,
                ),
                () => '',
              ),
              bytesDone: done,
              totalBytes: item.totalBytes,
              bps: 0,
              retryAt: null,
            };
            const canceled = yield* Deferred.make<void>();
            const now = yield* Clock.currentTimeMillis;
            yield* published(item);
            yield* hub.publish({ type: 'download-progress', payload: live });
            const running: Running = { id: item.id, canceled, live, lastEmit: now, lastBytes: done };
            return [Option.some({ item, canceled }), { ...s, running: Option.some(running) }] as const;
          }),
        );

        /**
         * Under the lock, from the transfer of item `id`: the progress is published at once when the phase or the file
         * changes, else at most every `liveEvery`, with the bytes per second smoothed.
         */
        const report =
          (id: number) =>
          (progress: TransferProgress): Effect.Effect<void> =>
            SynchronizedRef.updateEffect(state, (s) =>
              Effect.gen(function* () {
                if (Option.isNone(s.running) || s.running.value.id !== id || (yield* Ref.get(closing))) return s;
                const run = s.running.value;
                const now = yield* Clock.currentTimeMillis;
                // A chunk's progress; an attempt or an answer that starts, `verifying` and `retrying` go out at once.
                const steady = progress.throttled;
                const elapsed = now - run.lastEmit;
                if (steady && elapsed < liveEveryMs) return s;
                const instant = steady && elapsed > 0 ? ((progress.bytesDone - run.lastBytes) * 1000) / elapsed : 0;
                const bps = !steady
                  ? progress.phase === 'downloading'
                    ? run.live.bps
                    : 0
                  : run.live.bps > 0
                    ? 0.7 * run.live.bps + 0.3 * instant
                    : instant;
                const live: DownloadLive = {
                  ...run.live,
                  phase: progress.phase,
                  file: progress.file,
                  bytesDone: progress.bytesDone,
                  retryAt: progress.retryAt,
                  bps,
                };
                yield* hub.publish({ type: 'download-progress', payload: live });
                const next: Running = { ...run, live, lastEmit: now, lastBytes: progress.bytesDone };
                return { ...s, running: Option.some(next) };
              }),
            );

        /** Runs the transfer until it ends or the item is canceled; a cancel waits for the transfer to stop. */
        const process = Effect.fnUntraced(function* (item: DownloadItem, canceled: Deferred.Deferred<void>) {
          const fiber = yield* Effect.forkChild(transfer(item, report(item.id)).pipe(Effect.provideContext(context)));
          const outcome = yield* Effect.raceFirst(
            Effect.map(Fiber.await(fiber), outcomeOf),
            Effect.as(Deferred.await(canceled), { _tag: 'canceled' } as const),
          ).pipe(Effect.onInterrupt(() => Fiber.interrupt(fiber)));
          if (outcome._tag === 'canceled') yield* Fiber.interrupt(fiber);
          return outcome;
        });

        /** A transfer that gave up: logged (a defect with its cause), the item saved `error`. */
        const failed = Effect.fnUntraced(function* (
          item: DownloadItem,
          outcome: Extract<Outcome, { readonly _tag: 'error' }>,
        ) {
          const line = `[llama-webui] download ${item.repo}/${item.key} failed: ${outcome.message}`;
          yield* Option.match(outcome.defect, {
            onNone: () => Effect.logError(line),
            onSome: (cause) => Effect.logError(line, cause),
          });
          return yield* repo.setStatus(item.id, 'error', { error: outcome.message, code: outcome.code });
        });

        /** Under the lock: the item saved and published with how it ended, nothing running any more. */
        const finish = (id: number, canceled: Deferred.Deferred<void>, outcome: Outcome) =>
          SynchronizedRef.updateEffect(state, (s) =>
            Effect.gen(function* () {
              // Stopping: the item stays `downloading`, resumed by the next start.
              if (yield* Ref.get(closing)) return s;
              const found = yield* repo.get(id);
              if (Option.isNone(found)) return yield* Effect.die(`download ${id} left the table while it ran`);
              const item = found.value;
              // Canceled, even when the transfer ended first: the cancel came before this look.
              const wasCanceled = yield* Deferred.isDone(canceled);
              const saved = yield* wasCanceled
                ? discard(item).pipe(
                    // Canceled all the same; what is left on disk is named in the log.
                    Effect.catch((error) =>
                      Effect.logWarning(
                        `[llama-webui] download ${item.repo}/${item.key} canceled, ` +
                          `but what it wrote in ${item.dir} could not all be deleted:`,
                        error,
                      ),
                    ),
                    Effect.andThen(repo.setStatus(id, 'canceled')),
                  )
                : outcome._tag === 'error'
                  ? failed(item, outcome)
                  : repo.setStatus(id, 'done');
              yield* published(saved);
              yield* hub.publish({ type: 'download-progress', payload: null });
              return { ...s, running: Option.none() };
            }),
          );

        /**
         * A failure that gets out (the database failing…) is logged, and nothing runs any more: the item stays as it
         * was (`downloading`), taken first by the next start, at once when work was added since the loop last looked.
         */
        const stopped = Effect.fnUntraced(function* (cause: Cause.Cause<unknown>) {
          yield* Effect.logError('[llama-webui] download queue stopped:', cause);
          yield* SynchronizedRef.updateEffect(state, (s) =>
            Effect.gen(function* () {
              if (Option.isSome(s.running)) yield* hub.publish({ type: 'download-progress', payload: null });
              const idle: State = { loop: Option.none(), running: Option.none() };
              return (yield* Ref.get(dirty)) ? yield* kicked(idle) : idle;
            }),
          );
        });

        /** One item after the other, until none is left. */
        const loop: Effect.Effect<void> = Effect.gen(function* () {
          while (true) {
            const picked = yield* pick;
            if (Option.isNone(picked)) return;
            const { item, canceled } = picked.value;
            const outcome = yield* process(item, canceled);
            yield* finish(item.id, canceled, outcome);
          }
        }).pipe(
          Effect.onExit((exit) =>
            Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause) ? stopped(exit.cause) : Effect.void,
          ),
          Effect.withSpan('Downloads.loop', { root: true }),
        );

        const list = SynchronizedRef.modifyEffect(state, (s) =>
          Effect.map(repo.list, (items) => [{ items, live: liveOf(s) }, s] as const),
        ).pipe(Effect.withSpan('Downloads.list'));

        const enqueue = Effect.fn('Downloads.enqueue')(function* (inputs: ReadonlyArray<NewDownload>) {
          return yield* serial(
            Effect.gen(function* () {
              // Named twice in one call: the second is already in the queue the first makes.
              const seen = new Set<string>();
              for (const input of inputs) {
                const key = `${input.repo}\n${input.key}`;
                if (seen.has(key)) return yield* alreadyQueued(input.name);
                seen.add(key);
                yield* refuseQueued(input);
              }
              const todo: Array<NewDownload> = [];
              let need = 0;
              for (const input of inputs) {
                const left = yield* remaining(input.dir, input.files);
                need += left.bytes;
                if (Arr.isReadonlyArrayNonEmpty(left.files)) todo.push({ ...input, files: left.files });
              }
              const [first] = todo;
              if (first === undefined) return [];
              yield* checkSpace(first.dir, need);
              // The rows (one transaction), their messages and the loop's start in one step: a cancel or a list
              // sees all or none.
              return yield* SynchronizedRef.modifyEffect(state, (s) =>
                Effect.gen(function* () {
                  const items = yield* repo.createAll(todo);
                  yield* Effect.forEach(items, published, { discard: true });
                  return [items, yield* kicked(s)] as const;
                }),
              ).pipe(Effect.uninterruptible);
            }),
          );
        });

        const retry = Effect.fn('Downloads.retry')(function* (id: number) {
          return yield* serial(
            Effect.gen(function* () {
              const found = yield* repo.get(id);
              if (Option.isNone(found)) return yield* DownloadNotFound.make({ message: 'Download not found' });
              const item = found.value;
              if (item.status !== 'error' && item.status !== 'canceled') {
                return yield* NotFinished.make({ message: 'Only a failed or canceled download can be retried' });
              }
              yield* refuseQueued(item);
              const left = yield* remaining(item.dir, item.files);
              yield* checkSpace(item.dir, left.bytes);
              return yield* SynchronizedRef.modifyEffect(state, (s) =>
                Effect.gen(function* () {
                  const queued = yield* repo.requeue(id);
                  yield* published(queued);
                  return [queued, yield* kicked(s)] as const;
                }),
              ).pipe(Effect.uninterruptible);
            }),
          );
        });

        const remove = Effect.fn('Downloads.remove')(function* (id: number) {
          yield* SynchronizedRef.modifyEffect(state, (s) =>
            Effect.gen(function* () {
              const found = yield* repo.get(id);
              if (Option.isNone(found)) return yield* DownloadNotFound.make({ message: 'Download not found' });
              const item = found.value;
              if (Option.isSome(s.running) && s.running.value.id === id) {
                // The loop stops the transfer, then deletes, saves and publishes: not waited for here.
                yield* Deferred.succeed(s.running.value.canceled, undefined);
              } else if (isDownloadActive(item.status)) {
                // Out of the queue first: the loop must not take it while its files are deleted.
                const canceled = yield* repo.setStatus(id, 'canceled');
                yield* published(canceled);
                yield* Effect.orDie(discard(item));
              } else {
                yield* repo.remove(id);
                yield* hub.publish({ type: 'download-deleted', payload: { ids: [id] } });
              }
              return [undefined, s] as const;
            }),
          ).pipe(Effect.uninterruptible);
        });

        const clear = SynchronizedRef.modifyEffect(state, (s) =>
          Effect.gen(function* () {
            const ids = yield* repo.clearFinished;
            if (Arr.isReadonlyArrayNonEmpty(ids)) yield* hub.publish({ type: 'download-deleted', payload: { ids } });
            return [ids.length, s] as const;
          }),
        ).pipe(Effect.uninterruptible, Effect.withSpan('Downloads.clear'));

        // The transfer stops, nothing is written after it: the item stays `downloading`, its `.part` kept. The loop is
        // read under the lock and stopped outside it, its last step taking the lock.
        yield* shutdown.before(
          Effect.gen(function* () {
            const running = yield* SynchronizedRef.modifyEffect(state, (s) =>
              Effect.as(Ref.set(closing, true), [s.loop, s] as const),
            );
            if (Option.isSome(running)) yield* Fiber.interrupt(running.value);
          }).pipe(Effect.withSpan('Downloads.shutdown')),
        );

        // The items left queued or downloading by the last run.
        yield* SynchronizedRef.updateEffect(state, kicked);

        return Downloads.of({ list, enqueue, retry, remove, clear });
      }),
    );

  /** The queue on the disk's free space, a 1 GiB margin; attempts after 2, 4, 8, 16 and 30 s, restarted after 60 s without data. */
  static readonly layer = Downloads.layerWith({ retryDelays: RETRY_DELAYS, stall: STALL, liveEvery: '250 millis' });
}
