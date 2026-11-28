import * as NodeServices from '@effect/platform-node/NodeServices';
import { assert, layer } from '@effect/vitest';
import { AlreadyQueued, DiskFull, type DownloadItem, NotFinished, type WsMessage } from '@llama-webui/shared';
import {
  Array as Arr,
  Cause,
  ConfigProvider,
  Context,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Logger,
  Metric,
  Option,
  Order,
  Path,
  Queue,
  Ref,
  Schema,
  String as Str,
  SynchronizedRef,
} from 'effect';
import { SqlClient } from 'effect/sql';
import type { NewDownload } from '../hf/repo.ts';
import { DownloadMetrics } from '../runtime/Metrics.ts';
import { ServicesWithoutQueue } from '../testing/services.ts';
import { WsHub } from '../ws/WsHub.ts';
import { Downloads } from './Downloads.ts';
import { DownloadsRepo } from './DownloadsRepo.ts';
import type { Transfer, TransferFailed } from './transfer.ts';

const GiB = 1024 * 1024 * 1024;
const SHA = Str.repeat(40)('a');

/** The home of the test (`HOME`): the downloads go to `<home>/models/o/r`. */
class Home extends Context.Service<Home, string>()('@llama-webui/app/server/downloads/Downloads.test/Home') {}

/** The messages the queue published, in order. */
class Published extends Context.Service<Published, Ref.Ref<ReadonlyArray<WsMessage>>>()(
  '@llama-webui/app/server/downloads/Downloads.test/Published',
) {}

/** The free space the queue is told (null: unknown). */
class Free extends Context.Service<Free, Ref.Ref<number | null>>()(
  '@llama-webui/app/server/downloads/Downloads.test/Free',
) {}

/** What a transfer of the test does once it is released. */
type Step = (
  item: DownloadItem,
) => Effect.Effect<void, TransferFailed, FileSystem.FileSystem | Path.Path | DownloadsRepo | SqlClient.SqlClient>;

/**
 * Puts every file not done in place as the real transfer does: one found in place at its size is only marked done;
 * another is written, recorded placed by the item, then marked done.
 */
const place: Step = Effect.fnUntraced(function* (item) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const repo = yield* DownloadsRepo;
  for (const file of Arr.filter(item.files, (f) => !f.done)) {
    const dest = path.join(item.dir, file.path);
    const found = yield* fs.stat(dest).pipe(Effect.option);
    if (!Option.exists(found, (info) => Number(info.size) === file.size)) {
      yield* fs.makeDirectory(path.dirname(dest), { recursive: true });
      yield* fs.writeFileString(dest, Str.repeat(file.size)('x'));
      yield* fs.remove(`${dest}.part`, { force: true });
      yield* repo.filePlaced(item.id, file.path);
    }
    yield* repo.fileDone(item.id, file.path);
  }
}, Effect.orDie);

/** Writes `bytes` of the first file's `.part`, then never ends. */
const hang =
  (bytes: number): Step =>
  (item) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const file = Option.getOrThrow(Arr.head(item.files));
      const dest = path.join(item.dir, file.path);
      yield* fs.makeDirectory(path.dirname(dest), { recursive: true });
      yield* fs.writeFileString(`${dest}.part`, Str.repeat(bytes)('x'));
      return yield* Effect.never;
    }).pipe(Effect.orDie);

/** The transfers the queue runs: each waits for the step the test releases for its item. */
class Transfers extends Context.Service<
  Transfers,
  {
    readonly transfer: Transfer;
    /** The ids of the items whose transfer started, in order (once per transfer). */
    readonly started: Effect.Effect<ReadonlyArray<number>>;
    /** The ids of the items whose transfer was interrupted. */
    readonly interrupted: Effect.Effect<ReadonlyArray<number>>;
    /** The next transfer of `id` runs `step` (`place` by default); released before it starts, it does not wait. */
    readonly release: (id: number, step?: Step) => Effect.Effect<void>;
  }
>()('@llama-webui/app/server/downloads/Downloads.test/Transfers') {
  static readonly layer = Layer.effect(
    Transfers,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const steps = yield* SynchronizedRef.make<ReadonlyMap<number, Queue.Queue<Step>>>(new Map());
      const started = yield* Ref.make<ReadonlyArray<number>>([]);
      const interrupted = yield* Ref.make<ReadonlyArray<number>>([]);
      const stepsOf = (id: number) =>
        SynchronizedRef.modifyEffect(steps, (map) => {
          const queue = map.get(id);
          return queue === undefined
            ? Effect.map(Queue.unbounded<Step>(), (made) => [made, new Map(map).set(id, made)] as const)
            : Effect.succeed([queue, map] as const);
        });
      const transfer: Transfer = (item) =>
        Effect.gen(function* () {
          const queue = yield* stepsOf(item.id);
          yield* Ref.update(started, Arr.append(item.id));
          const step = yield* Queue.take(queue);
          yield* step(item).pipe(Effect.provideService(SqlClient.SqlClient, sql));
        }).pipe(Effect.onInterrupt(() => Ref.update(interrupted, Arr.append(item.id))));
      return Transfers.of({
        transfer,
        started: Ref.get(started),
        interrupted: Ref.get(interrupted),
        release: (id, step = place) =>
          Effect.flatMap(stepsOf(id), (queue) => Queue.offer(queue, step)).pipe(Effect.asVoid),
      });
    }),
  );
}

/** A `WsHub` that records what is published. */
const RecordingHub = Layer.effect(
  WsHub,
  Effect.gen(function* () {
    const published = yield* Published;
    return WsHub.of({
      publish: (message) => Ref.update(published, Arr.append(message)),
      size: Effect.succeed(0),
      attach: () => Effect.void,
    });
  }),
);

/** What was logged at error level, as text. */
const errors: Array<string> = [];
const Errors = Logger.layer([
  Logger.make(({ logLevel, message }) => {
    if (logLevel === 'Error')
      errors.push(Arr.isArray(message) ? Arr.join(Arr.map(message, String), ' ') : String(message));
  }),
]);

/** The services of the app with `HOME` a temporary folder and no token, the test's transfers, free space and log. */
const Base = Layer.mergeAll(
  Transfers.layer,
  Layer.effect(Free, Ref.make<number | null>(null)),
  Layer.effect(Published, Ref.make<ReadonlyArray<WsMessage>>([])),
  Errors,
).pipe(
  Layer.provideMerge(ServicesWithoutQueue),
  Layer.provideMerge(
    ConfigProvider.layerAdd(
      Effect.gen(function* () {
        const home = yield* Home;
        return ConfigProvider.fromUnknown({
          HOME: home,
          // Nothing answers there: the test's transfers never reach a Hub.
          HF_ENDPOINT: 'http://127.0.0.1:9',
          HF_TOKEN: '',
          HUGGING_FACE_HUB_TOKEN: '',
          HF_TOKEN_PATH: `${home}/no-token`,
        });
      }),
      { asPrimary: true },
    ),
  ),
  Layer.provideMerge(
    Layer.effect(
      Home,
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        return yield* fs.makeTempDirectoryScoped({ prefix: 'lw-downloads-' });
      }),
    ),
  ),
  Layer.provideMerge(NodeServices.layer),
);

/** The queue on the test's transfers, free space and hub; no margin unless one is given. */
const Queued = (options: { readonly marginBytes?: number } = { marginBytes: 0 }) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const transfers = yield* Transfers;
      const free = yield* Free;
      return Downloads.layerWith({
        freeBytes: () => Ref.get(free),
        transfer: transfers.transfer,
        ...(options.marginBytes === undefined ? {} : { marginBytes: options.marginBytes }),
      });
    }),
  ).pipe(Layer.provide(RecordingHub));

/** `test` with a queue of its own, undone at its end. */
const withQueue = <A, E, R>(test: Effect.Effect<A, E, R>, options?: { readonly marginBytes?: number }) =>
  Layer.build(Queued(options)).pipe(
    Effect.flatMap((context) => Effect.provideContext(test, context)),
    Effect.scoped,
  );

/** The folder of `o/r` under the test's models folder. */
const repoDir = Effect.gen(function* () {
  const home = yield* Home;
  const path = yield* Path.Path;
  return path.join(home, 'models', 'o', 'r');
});

/** A variant of `o/r` whose files are `[path, size]`. */
const input = (key: string, files: ReadonlyArray<readonly [string, number]> = [[key, 100]]) =>
  Effect.map(repoDir, (dir): NewDownload => ({
    repo: 'o/r',
    revision: SHA,
    key,
    name: Str.replace(/\.gguf$/, '')(key),
    quant: null,
    kind: 'model',
    dir,
    files: Arr.map(files, ([path, size]) => ({ path, size, sha256: null })),
  }));

/** Fails the test unless `effect` gives `expected`. */
const expectEqual = <A, E, R>(effect: Effect.Effect<A, E, R>, expected: A) =>
  Effect.map(effect, (actual) => assert.deepStrictEqual(actual, expected));

const expectTrue = <E, R>(effect: Effect.Effect<boolean, E, R>) =>
  Effect.map(effect, (actual) => assert.isTrue(actual));

const expectFalse = <E, R>(effect: Effect.Effect<boolean, E, R>) =>
  Effect.map(effect, (actual) => assert.isFalse(actual));

/** A row of the table for a variant of `o/r`, written behind the queue's back. */
const stored = Effect.fnUntraced(function* (key: string, files?: ReadonlyArray<readonly [string, number]>) {
  const repo = yield* DownloadsRepo;
  const made = yield* input(key, files);
  return yield* repo.create(made);
});

/** Writes `size` bytes at `file` under the folder of `o/r`. */
const writeFile = Effect.fnUntraced(function* (file: string, size: number) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = yield* repoDir;
  const dest = path.join(dir, file);
  yield* fs.makeDirectory(path.dirname(dest), { recursive: true });
  yield* fs.writeFileString(dest, Str.repeat(size)('x'));
}, Effect.orDie);

const exists = Effect.fnUntraced(function* (file: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = yield* repoDir;
  return yield* fs.exists(path.join(dir, file));
}, Effect.orDie);

/** Waits (real time, 5 s at most) until `check` holds. */
const eventually = Effect.fnUntraced(
  function* <R>(check: Effect.Effect<boolean, never, R>) {
    while (!(yield* check)) yield* Effect.sleep('10 millis');
  },
  Effect.timeout('5 seconds'),
  Effect.orDie,
);

const statusOf = Effect.fnUntraced(function* (id: number) {
  const repo = yield* DownloadsRepo;
  const item = yield* repo.get(id);
  return Option.map(item, (found) => found.status);
});

/** Waits until item `id` has `status`. */
const reaches = (id: number, status: DownloadItem['status']) =>
  eventually(Effect.map(statusOf(id), Option.contains(status)));

/** Waits until the transfer of item `id` started `n` times in all. */
const startedTimes = Effect.fnUntraced(function* (id: number, n = 1) {
  const transfers = yield* Transfers;
  yield* eventually(Effect.map(transfers.started, (ids) => Arr.filter(ids, (started) => started === id).length >= n));
});

/** The messages published so far, as `[type, id, status]` (`id` and `status` null where they do not apply). */
const messages = Effect.gen(function* () {
  const published = yield* Published;
  const all = yield* Ref.get(published);
  return Arr.map(all, (message) => {
    switch (message.type) {
      case 'download':
        return [message.type, message.payload.id, message.payload.status] as const;
      case 'download-progress':
        return [message.type, message.payload?.id ?? null, null] as const;
      case 'download-deleted':
        return [message.type, Arr.join(Arr.map(message.payload.ids, String), ','), null] as const;
      default:
        return [message.type, null, null] as const;
    }
  });
});

/** The statuses published for item `id`, in order. */
const statuses = (id: number) =>
  Effect.map(messages, (all) =>
    Arr.getSomes(
      Arr.map(all, ([type, of, status]) => (type === 'download' && of === id ? Option.some(status) : Option.none())),
    ),
  );

const setFree = Effect.fnUntraced(function* (bytes: number | null) {
  const free = yield* Free;
  yield* Ref.set(free, bytes);
});

layer(Base, { excludeTestServices: true, buildPerTest: true })('Downloads', (it) => {
  it.effect(
    'concurrent or repeated requests for one variant queue it once; retry refuses a variant already queued',
    () =>
      withQueue(
        Effect.gen(function* () {
          const downloads = yield* Downloads;
          const repo = yield* DownloadsRepo;
          const m = yield* input('m.gguf');
          // Named twice in one call: the second is already in the queue the first makes.
          const twice = yield* Effect.flip(downloads.enqueue([m, m]));
          assert.instanceOf(twice, AlreadyQueued);
          yield* expectEqual(repo.list, []);
          const both = yield* Effect.all([Effect.exit(downloads.enqueue([m])), Effect.exit(downloads.enqueue([m]))], {
            concurrency: 'unbounded',
          });
          assert.deepStrictEqual(Arr.sort(Arr.map(both, Exit.isSuccess), Order.Boolean), [false, true]);
          const refused = Arr.findFirst(both, Exit.isFailure);
          assert.isTrue(
            Option.exists(
              refused,
              (exit) =>
                Exit.isFailure(exit) && Option.exists(Cause.findErrorOption(exit.cause), Schema.is(AlreadyQueued)),
            ),
          );
          const active = yield* repo.active;
          assert.strictEqual(active.length, 1);
          // An older failed item for the same variant cannot be put back next to it.
          const old = yield* repo.create(m);
          yield* repo.setStatus(old.id, 'error', { error: 'boom' });
          const again = yield* Effect.flip(downloads.retry(old.id));
          assert.deepStrictEqual(again, AlreadyQueued.make({ message: 'm is already in the download queue' }));
        }),
      ),
  );

  it.effect('retry checks the disk space like a new download', () =>
    withQueue(
      Effect.gen(function* () {
        const downloads = yield* Downloads;
        const repo = yield* DownloadsRepo;
        yield* setFree(500);
        const failed = yield* stored('m.gguf', [['m.gguf', 1000]]);
        yield* repo.setStatus(failed.id, 'error', { error: 'Disk full', code: 'disk-full' });
        const refused = yield* Effect.flip(downloads.retry(failed.id));
        assert.instanceOf(refused, DiskFull);
        yield* expectEqual(statusOf(failed.id), Option.some('error' as const));
      }),
    ),
  );

  it.effect('refuses a duplicate and a download that does not fit on the disk; skips files already there', () =>
    withQueue(
      Effect.gen(function* () {
        const downloads = yield* Downloads;
        const repo = yield* DownloadsRepo;
        const transfers = yield* Transfers;
        yield* setFree(1200);
        const m = yield* input('m.gguf', [['m.gguf', 1000]]);
        const n = yield* input('n.gguf', [['n.gguf', 500]]);
        const full = yield* Effect.flip(downloads.enqueue([m, n]));
        assert.instanceOf(full, DiskFull);
        yield* expectEqual(repo.list, []);
        yield* writeFile('n.gguf', 500);
        const created = yield* downloads.enqueue([m, n]);
        assert.deepStrictEqual(
          Arr.map(created, (item) => item.key),
          ['m.gguf'],
        );
        const queued = yield* Effect.flip(downloads.enqueue([m]));
        assert.deepStrictEqual(queued, AlreadyQueued.make({ message: 'm is already in the download queue' }));
        const [item] = created;
        if (item === undefined) return assert.fail('no item');
        yield* transfers.release(item.id, hang(10));
        yield* startedTimes(item.id);
        yield* downloads.remove(item.id);
        yield* reaches(item.id, 'canceled');
      }),
    ),
  );

  it.effect('an item that ends is counted by its status, and timed', () =>
    withQueue(
      Effect.gen(function* () {
        const downloads = yield* Downloads;
        const transfers = yield* Transfers;
        const [m, n] = yield* downloads.enqueue([yield* input('m.gguf'), yield* input('n.gguf')]);
        if (m === undefined || n === undefined) return assert.fail('no items');
        yield* transfers.release(m.id);
        yield* reaches(m.id, 'done');
        // Canceled while it runs.
        yield* transfers.release(n.id, hang(1000));
        yield* eventually(exists('n.gguf.part'));
        yield* downloads.remove(n.id);
        yield* reaches(n.id, 'canceled');
        const done = Metric.withAttributes(DownloadMetrics.items, { status: 'done' });
        const canceled = Metric.withAttributes(DownloadMetrics.items, { status: 'canceled' });
        assert.strictEqual((yield* Metric.value(done)).count, 1);
        assert.strictEqual((yield* Metric.value(canceled)).count, 1);
        assert.strictEqual((yield* Metric.value(DownloadMetrics.duration)).count, 2);
        assert.strictEqual((yield* Metric.value(DownloadMetrics.bps)).value, 0);
      }),
    ).pipe(Effect.provideService(Metric.MetricRegistry, new Map())),
  );

  it.effect('remove and clear finished items', () =>
    withQueue(
      Effect.gen(function* () {
        const downloads = yield* Downloads;
        const transfers = yield* Transfers;
        const [m, n] = yield* downloads.enqueue([yield* input('m.gguf'), yield* input('n.gguf')]);
        if (m === undefined || n === undefined) return assert.fail('no items');
        yield* transfers.release(m.id);
        yield* transfers.release(n.id);
        yield* reaches(n.id, 'done');
        yield* downloads.remove(m.id);
        yield* expectEqual(downloads.clear, 1);
        yield* expectEqual(downloads.clear, 0);
        const all = yield* messages;
        const deleted = Arr.filter(all, ([type]) => type === 'download-deleted');
        assert.deepStrictEqual(deleted, [
          ['download-deleted', String(m.id), null],
          ['download-deleted', String(n.id), null],
        ]);
        const list = yield* downloads.list;
        assert.deepStrictEqual(list, { items: [], live: null });
        // Their files stay.
        yield* expectTrue(exists('m.gguf'));
        yield* expectTrue(exists('n.gguf'));
        const missing = yield* Effect.flip(downloads.remove(m.id));
        assert.strictEqual(missing._tag, 'DownloadNotFound');
      }),
    ),
  );

  it.effect('cancel: a running item stops and its files are deleted; a queued one never starts', () =>
    withQueue(
      Effect.gen(function* () {
        const downloads = yield* Downloads;
        const transfers = yield* Transfers;
        const fs = yield* FileSystem.FileSystem;
        const dir = yield* repoDir;
        const [a, b] = yield* downloads.enqueue([
          yield* input('Q8/a.gguf', [
            ['Q8/a-00001-of-00002.gguf', 100],
            ['Q8/a-00002-of-00002.gguf', 3000],
          ]),
          yield* input('b.gguf', [['b.gguf', 1000]]),
        ]);
        if (a === undefined || b === undefined) return assert.fail('no items');
        // The first shard placed, the second begun.
        yield* transfers.release(a.id, (item) =>
          Effect.flatMap(place({ ...item, files: Arr.take(item.files, 1) }), () =>
            hang(1000)({ ...item, files: Arr.drop(item.files, 1) }),
          ),
        );
        yield* eventually(exists('Q8/a-00002-of-00002.gguf.part'));
        const live = yield* downloads.list;
        assert.strictEqual(live.live?.id, a.id);
        yield* downloads.remove(b.id);
        yield* expectEqual(statusOf(b.id), Option.some('canceled' as const));
        yield* downloads.remove(a.id);
        yield* reaches(a.id, 'canceled');
        yield* expectEqual(transfers.interrupted, [a.id]);
        yield* expectFalse(exists('Q8/a-00002-of-00002.gguf.part'));
        yield* expectFalse(exists('Q8/a-00001-of-00002.gguf'));
        // The folders it created are gone too, up to the models folder.
        yield* expectFalse(fs.exists(dir));
        const path = yield* Path.Path;
        yield* expectTrue(fs.exists(path.dirname(path.dirname(dir))));
        yield* expectEqual(transfers.started, [a.id]);
        assert.deepStrictEqual((yield* downloads.list).live, null);
        // Retried, it runs again; once done, a remove takes it out of the list.
        yield* downloads.retry(a.id);
        yield* transfers.release(a.id);
        yield* reaches(a.id, 'done');
        yield* downloads.remove(a.id);
        yield* expectEqual(statusOf(a.id), Option.none());
      }),
    ),
  );

  it.effect('cancel keeps a file another item of the list names too: its copy in place and its .part', () =>
    withQueue(
      Effect.gen(function* () {
        const downloads = yield* Downloads;
        const transfers = yield* Transfers;
        // Three variants of one repository, queued while their shared projector is not on disk: each lists it.
        const [a, b, c] = yield* downloads.enqueue([
          yield* input('a.gguf', [
            ['a.gguf', 100],
            ['mmproj.gguf', 50],
          ]),
          yield* input('b.gguf', [
            ['b.gguf', 100],
            ['mmproj.gguf', 50],
          ]),
          yield* input('c.gguf', [
            ['mmproj.gguf', 50],
            ['c.gguf', 100],
          ]),
        ]);
        if (a === undefined || b === undefined || c === undefined) return assert.fail('no items');
        yield* transfers.release(a.id);
        yield* reaches(a.id, 'done');
        // A queued item canceled: the projector the first one placed stays.
        yield* downloads.remove(c.id);
        yield* expectEqual(statusOf(c.id), Option.some('canceled' as const));
        yield* expectTrue(exists('mmproj.gguf'));
        // A running item canceled, which found the projector in place (marked done) and began its own file.
        yield* transfers.release(b.id, (item) =>
          Effect.flatMap(place({ ...item, files: Arr.drop(item.files, 1) }), () =>
            hang(40)({ ...item, files: Arr.take(item.files, 1) }),
          ),
        );
        yield* eventually(exists('b.gguf.part'));
        yield* downloads.remove(b.id);
        yield* reaches(b.id, 'canceled');
        yield* expectFalse(exists('b.gguf.part'));
        yield* expectTrue(exists('mmproj.gguf'));
        yield* expectTrue(exists('a.gguf'));
      }),
    ),
  );

  it.effect('cancel keeps a file another download placed, once that item is cleared from the list (#109)', () =>
    withQueue(
      Effect.gen(function* () {
        const downloads = yield* Downloads;
        const transfers = yield* Transfers;
        // Three variants of one repository, queued while their shared projector is not on disk: each lists it.
        const [a, b, c] = yield* downloads.enqueue([
          yield* input('a.gguf', [
            ['a.gguf', 100],
            ['mmproj.gguf', 50],
          ]),
          yield* input('b.gguf', [
            ['mmproj.gguf', 50],
            ['b.gguf', 100],
          ]),
          yield* input('c.gguf', [
            ['mmproj.gguf', 50],
            ['c.gguf', 100],
          ]),
        ]);
        if (a === undefined || b === undefined || c === undefined) return assert.fail('no items');
        yield* transfers.release(a.id);
        yield* reaches(a.id, 'done');
        yield* expectEqual(downloads.clear, 1);
        // A running item canceled, which found the projector in place (marked done) and began its own file.
        yield* transfers.release(b.id, (item) =>
          Effect.flatMap(place({ ...item, files: Arr.take(item.files, 1) }), () =>
            hang(40)({ ...item, files: Arr.drop(item.files, 1) }),
          ),
        );
        yield* eventually(exists('b.gguf.part'));
        yield* downloads.remove(b.id);
        yield* reaches(b.id, 'canceled');
        yield* expectFalse(exists('b.gguf.part'));
        yield* expectTrue(exists('mmproj.gguf'));
        // A queued item canceled: no item of the list names the projector any more, and it stays all the same.
        yield* downloads.remove(c.id);
        yield* reaches(c.id, 'canceled');
        yield* expectTrue(exists('mmproj.gguf'));
        yield* expectTrue(exists('a.gguf'));
      }),
    ),
  );

  it.effect('a canceled item retried owns none of the files it placed before (#109)', () =>
    withQueue(
      Effect.gen(function* () {
        const downloads = yield* Downloads;
        const transfers = yield* Transfers;
        const repo = yield* DownloadsRepo;
        const [a, b] = yield* downloads.enqueue([
          yield* input('a.gguf', [
            ['mmproj.gguf', 50],
            ['a.gguf', 100],
          ]),
          yield* input('b.gguf', [
            ['mmproj.gguf', 50],
            ['b.gguf', 100],
          ]),
        ]);
        if (a === undefined || b === undefined) return assert.fail('no items');
        // The first places the projector, then is canceled: the projector stays for the second, which names it.
        yield* transfers.release(a.id, (item) =>
          Effect.flatMap(place({ ...item, files: Arr.take(item.files, 1) }), () =>
            hang(40)({ ...item, files: Arr.drop(item.files, 1) }),
          ),
        );
        yield* eventually(exists('a.gguf.part'));
        yield* expectEqual(repo.placedFiles(a.id), ['mmproj.gguf']);
        yield* downloads.remove(a.id);
        yield* reaches(a.id, 'canceled');
        yield* expectTrue(exists('mmproj.gguf'));
        yield* downloads.retry(a.id);
        yield* expectEqual(repo.placedFiles(a.id), []);
      }),
    ),
  );

  it.effect('cancel keeps the .part an item still queued will resume, and deletes it with the last one', () =>
    withQueue(
      Effect.gen(function* () {
        const downloads = yield* Downloads;
        const transfers = yield* Transfers;
        const [a, b] = yield* downloads.enqueue([
          yield* input('a.gguf', [
            ['mmproj.gguf', 50],
            ['a.gguf', 100],
          ]),
          yield* input('b.gguf', [
            ['mmproj.gguf', 50],
            ['b.gguf', 100],
          ]),
        ]);
        if (a === undefined || b === undefined) return assert.fail('no items');
        yield* transfers.release(a.id, hang(20));
        yield* eventually(exists('mmproj.gguf.part'));
        yield* downloads.remove(a.id);
        yield* reaches(a.id, 'canceled');
        yield* expectTrue(exists('mmproj.gguf.part'));
        // No other item names it any more: the last cancel deletes it.
        yield* startedTimes(b.id);
        yield* downloads.remove(b.id);
        yield* reaches(b.id, 'canceled');
        yield* expectFalse(exists('mmproj.gguf.part'));
      }),
    ),
  );

  it.effect('an enqueue whose every file is on disk creates no row and answers an empty list', () =>
    withQueue(
      Effect.gen(function* () {
        const downloads = yield* Downloads;
        yield* writeFile('m-00001-of-00002.gguf', 100);
        yield* writeFile('m-00002-of-00002.gguf', 200);
        const created = yield* downloads.enqueue([
          yield* input('m.gguf', [
            ['m-00001-of-00002.gguf', 100],
            ['m-00002-of-00002.gguf', 200],
          ]),
        ]);
        assert.deepStrictEqual(created, []);
        yield* expectEqual(downloads.list, { items: [], live: null });
        yield* expectEqual(messages, []);
      }),
    ),
  );

  it.effect('retry of a done or queued item is NotFinished', () =>
    withQueue(
      Effect.gen(function* () {
        const downloads = yield* Downloads;
        const transfers = yield* Transfers;
        const notFinished = NotFinished.make({ message: 'Only a failed or canceled download can be retried' });
        const [a] = yield* downloads.enqueue([yield* input('a.gguf')]);
        if (a === undefined) return assert.fail('no item');
        yield* startedTimes(a.id);
        // Running, then one queued behind it.
        yield* expectEqual(Effect.flip(downloads.retry(a.id)), notFinished);
        const b = yield* stored('b.gguf');
        yield* expectEqual(Effect.flip(downloads.retry(b.id)), notFinished);
        yield* downloads.remove(b.id);
        yield* transfers.release(a.id);
        yield* reaches(a.id, 'done');
        yield* expectEqual(Effect.flip(downloads.retry(a.id)), notFinished);
        const missing = yield* Effect.flip(downloads.retry(a.id + 100));
        assert.strictEqual(missing._tag, 'DownloadNotFound');
      }),
    ),
  );

  it.effect('the disk space check counts the bytes the active items still have to write', () =>
    withQueue(
      Effect.gen(function* () {
        const downloads = yield* Downloads;
        yield* setFree(1500);
        const [a] = yield* downloads.enqueue([yield* input('a.gguf', [['a.gguf', 1000]])]);
        if (a === undefined) return assert.fail('no item');
        yield* startedTimes(a.id);
        // 1000 bytes of b, less its 400 bytes begun, and the 1000 bytes a still has to write: 1600.
        yield* writeFile('b.gguf.part', 400);
        const b = yield* input('b.gguf', [['b.gguf', 1000]]);
        const full = yield* Effect.flip(downloads.enqueue([b]));
        assert.deepStrictEqual(
          full,
          DiskFull.make({ message: 'Not enough disk space: 0 MiB to download (plus 0 MiB margin), 0 MiB free' }),
        );
        yield* setFree(1600);
        const created = yield* downloads.enqueue([b]);
        assert.deepStrictEqual(
          Arr.map(created, (item) => item.key),
          ['b.gguf'],
        );
      }),
    ),
  );

  it.effect('the disk space check keeps a 1 GiB margin', () =>
    withQueue(
      Effect.gen(function* () {
        const downloads = yield* Downloads;
        yield* setFree(2 * GiB);
        const big = yield* input('big.gguf', [['big.gguf', 1.5 * GiB]]);
        const full = yield* Effect.flip(downloads.enqueue([big]));
        assert.deepStrictEqual(
          full,
          DiskFull.make({ message: 'Not enough disk space: 1.5 GiB to download (plus 1.0 GiB margin), 2.0 GiB free' }),
        );
        // What fits with the margin, to the byte, is queued.
        const fits = yield* downloads.enqueue([yield* input('fits.gguf', [['fits.gguf', GiB]])]);
        assert.strictEqual(fits.length, 1);
        // Unknown, the free space is not checked.
        yield* setFree(null);
        const created = yield* downloads.enqueue([big]);
        assert.strictEqual(created.length, 1);
      }),
      {},
    ),
  );

  it.effect(
    'a queued item whose files cannot be deleted is still marked and published canceled, and the call dies',
    () =>
      withQueue(
        Effect.gen(function* () {
          const downloads = yield* Downloads;
          const transfers = yield* Transfers;
          const [a, b] = yield* downloads.enqueue([yield* input('a.gguf'), yield* input('b.gguf')]);
          if (a === undefined || b === undefined) return assert.fail('no items');
          yield* startedTimes(a.id);
          // Its `.part` is a folder that holds a file: it cannot be removed as a file.
          yield* writeFile('b.gguf.part/inside', 1);
          const exit = yield* Effect.exit(downloads.remove(b.id));
          assert.isTrue(Exit.isFailure(exit) && Cause.hasDies(exit.cause));
          yield* expectEqual(statusOf(b.id), Option.some('canceled' as const));
          yield* expectEqual(statuses(b.id), ['queued', 'canceled']);
          yield* transfers.release(a.id);
          yield* reaches(a.id, 'done');
          yield* expectEqual(transfers.started, [a.id]);
        }),
      ),
  );

  it.effect(
    'a failure that escapes the loop is logged download queue stopped and the item is picked up on the next start',
    () =>
      withQueue(
        Effect.gen(function* () {
          const downloads = yield* Downloads;
          const transfers = yield* Transfers;
          const sql = yield* SqlClient.SqlClient;
          errors.length = 0;
          const [a] = yield* downloads.enqueue([yield* input('a.gguf')]);
          if (a === undefined) return assert.fail('no item');
          // The table goes away under the transfer: the queue's next write fails.
          yield* transfers.release(a.id, () => Effect.orDie(sql`ALTER TABLE downloads RENAME TO downloads_away`));
          yield* eventually(Effect.sync(() => Arr.some(errors, Str.includes('[llama-webui] download queue stopped:'))));
          yield* Effect.orDie(sql`ALTER TABLE downloads_away RENAME TO downloads`);
          yield* expectEqual(statusOf(a.id), Option.some('downloading' as const));
          assert.deepStrictEqual((yield* downloads.list).live, null);
          // The next start takes it first, before the item that started it.
          const [b] = yield* downloads.enqueue([yield* input('b.gguf')]);
          if (b === undefined) return assert.fail('no item');
          yield* transfers.release(a.id);
          yield* transfers.release(b.id);
          yield* reaches(b.id, 'done');
          yield* expectEqual(statusOf(a.id), Option.some('done' as const));
          yield* expectEqual(transfers.started, [a.id, a.id, b.id]);
        }),
      ),
  );

  it.effect('work added while the loop runs is taken without a new call', () =>
    withQueue(
      Effect.gen(function* () {
        const downloads = yield* Downloads;
        const transfers = yield* Transfers;
        const [a] = yield* downloads.enqueue([yield* input('a.gguf')]);
        if (a === undefined) return assert.fail('no item');
        yield* startedTimes(a.id);
        // Written behind the queue's back: only the loop's next look finds it.
        const b = yield* stored('b.gguf');
        yield* transfers.release(b.id);
        yield* transfers.release(a.id);
        yield* reaches(b.id, 'done');
        yield* expectEqual(transfers.started, [a.id, b.id]);
      }),
    ),
  );

  it.effect('the layer resumes the item left downloading first, then the queued ones in order', () =>
    Effect.gen(function* () {
      const repo = yield* DownloadsRepo;
      const transfers = yield* Transfers;
      const q1 = yield* stored('q1.gguf');
      const q2 = yield* stored('q2.gguf');
      const left = yield* stored('left.gguf');
      yield* repo.setStatus(left.id, 'downloading');
      yield* Effect.forEach([q1.id, q2.id, left.id], (id) => transfers.release(id), { discard: true });
      yield* withQueue(Effect.all([reaches(q1.id, 'done'), reaches(q2.id, 'done'), reaches(left.id, 'done')]));
      yield* expectEqual(transfers.started, [left.id, q1.id, q2.id]);
      // The item left downloading is published as it runs again.
      yield* expectEqual(statuses(left.id), ['downloading', 'done']);
    }),
  );

  it.effect('each status change is published as download, a removal as download-deleted, in that order', () =>
    withQueue(
      Effect.gen(function* () {
        const downloads = yield* Downloads;
        const transfers = yield* Transfers;
        const [a] = yield* downloads.enqueue([yield* input('a.gguf')]);
        if (a === undefined) return assert.fail('no item');
        yield* transfers.release(a.id);
        yield* reaches(a.id, 'done');
        yield* downloads.remove(a.id);
        yield* expectEqual(messages, [
          ['download', a.id, 'queued'],
          ['download', a.id, 'downloading'],
          ['download-progress', a.id, null],
          ['download', a.id, 'done'],
          ['download-progress', null, null],
          ['download-deleted', String(a.id), null],
        ]);
      }),
    ),
  );
});
