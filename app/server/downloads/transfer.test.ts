import { NodeServices } from '@effect/platform-node';
import { assert, layer } from '@effect/vitest';
import type { DownloadItem, DownloadLive, WsMessage } from '@llama-webui/shared';
import {
  Array as Arr,
  Clock,
  ConfigProvider,
  Context,
  type Duration,
  Effect,
  FileSystem,
  Layer,
  Logger,
  Option,
  Path,
  PlatformError,
  Record as Rec,
  Ref,
  String as Str,
  Stream,
} from 'effect';
import { TestClock } from 'effect/testing';
import { partPath, sizeOf } from '../hf/paths.ts';
import type { NewDownload } from '../hf/repo.ts';
import { Shutdown } from '../runtime/Shutdown.ts';
import { type FakeHub, fakeHub } from '../testing/hub.ts';
import { ServicesWithoutQueue } from '../testing/services.ts';
import { WsHub } from '../ws/WsHub.ts';
import { Downloads } from './Downloads.ts';
import { DownloadsRepo } from './DownloadsRepo.ts';
import { sha256 } from './hash.ts';
import { type Transfer, TransferFailed, transferItem } from './transfer.ts';

const MiB = 1024 * 1024;

/** The home of the test (`HOME`): the downloads go to `<home>/models/o/r`. */
class Home extends Context.Service<Home, string>()('@llama-webui/app/server/downloads/transfer.test/Home') {}

/** The fake Hub of the test (`HF_ENDPOINT`), and its CDN. */
class Hub extends Context.Service<Hub, FakeHub>()('@llama-webui/app/server/downloads/transfer.test/Hub') {}

/** The messages the queue published, in order. */
class Published extends Context.Service<Published, Ref.Ref<ReadonlyArray<WsMessage>>>()(
  '@llama-webui/app/server/downloads/transfer.test/Published',
) {}

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

/** What was logged at error and warning level, as `[level, text]`. */
const logs: Array<readonly [string, string]> = [];
const Logs = Logger.layer([
  Logger.make(({ logLevel, message }) => {
    if (logLevel === 'Error' || logLevel === 'Warn') {
      logs.push([logLevel, Arr.isArray(message) ? Arr.join(Arr.map(message, String), ' ') : String(message)]);
    }
  }),
]);

/** The services of the app with `HOME` a temporary folder, the fake Hub as the endpoint and `hf_secret` as the token. */
const Base = Layer.mergeAll(Layer.effect(Published, Ref.make<ReadonlyArray<WsMessage>>([])), Logs).pipe(
  Layer.provideMerge(ServicesWithoutQueue),
  Layer.provideMerge(
    ConfigProvider.layerAdd(
      Effect.gen(function* () {
        const home = yield* Home;
        const hub = yield* Hub;
        return ConfigProvider.fromUnknown({
          HOME: home,
          HF_ENDPOINT: hub.url,
          HF_TOKEN: 'hf_secret',
          HUGGING_FACE_HUB_TOKEN: '',
          HF_TOKEN_PATH: `${home}/no-token`,
        });
      }),
      { asPrimary: true },
    ),
  ),
  Layer.provideMerge(
    Layer.mergeAll(
      Layer.effect(
        Home,
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          return yield* fs.makeTempDirectoryScoped({ prefix: 'lw-transfer-' });
        }),
      ),
      Layer.effect(Hub, fakeHub()),
    ),
  ),
  Layer.provideMerge(NodeServices.layer),
);

interface QueueOptions {
  /** The app's pauses and stall (`2, 4, 8, 16, 30 s`, 60 s), for the `TestClock`; else 10 ms pauses and a 5 s stall. */
  readonly appTiming?: boolean;
  readonly liveEvery?: Duration.Input;
  readonly transfer?: Transfer;
  /** The file system of the queue and its transfer. */
  readonly fs?: FileSystem.FileSystem;
}

/** The queue on the test's hub, with no disk space check, every progress published unless `liveEvery` says. */
const Queued = (options: QueueOptions = {}) => {
  const queue = Downloads.layerWith({
    freeBytes: () => Effect.succeed(null),
    marginBytes: 0,
    liveEvery: options.liveEvery ?? '0 millis',
    ...(options.appTiming === true
      ? {}
      : { retryDelays: Arr.replicate('10 millis', 5), stall: '5 seconds' as Duration.Input }),
    ...(options.transfer === undefined ? {} : { transfer: options.transfer }),
  }).pipe(Layer.provide(RecordingHub));
  return options.fs === undefined ? queue : queue.pipe(Layer.provide(Layer.succeed(FileSystem.FileSystem, options.fs)));
};

/** `test` with a queue of its own, undone at its end. */
const withQueue = <A, E, R>(test: Effect.Effect<A, E, R>, options?: QueueOptions) =>
  Layer.build(Queued(options)).pipe(
    Effect.flatMap((context) => Effect.provideContext(test, context)),
    Effect.scoped,
  );

/** `size` bytes that differ with `seed`. */
const data = (size: number, seed = 1): Uint8Array => {
  const out = new Uint8Array(size);
  for (let i = 0; i < size; i++) out[i] = (i * 31 + seed * 17) % 251;
  return out;
};

const hexOf = (bytes: Uint8Array): string => {
  const hash = sha256();
  hash.update(bytes);
  return hash.hex();
};

type Files = ReadonlyArray<readonly [string, Uint8Array]>;

/** The repository `o/r` of the fake Hub, with `files`. */
const serve = (files: Files) => Effect.map(Hub, (hub) => hub.add({ id: 'o/r', files: Rec.fromEntries(files) }));

/** The folder of `o/r` under the test's models folder. */
const repoDir = Effect.gen(function* () {
  const home = yield* Home;
  const path = yield* Path.Path;
  return path.join(home, 'models', 'o', 'r');
});

/** A variant of `o/r` (at the Hub's commit) whose files are `files`, with their sha256 unless `sha256` is given. */
const input = Effect.fnUntraced(function* (key: string, files: Files, sha256?: string) {
  const hub = yield* Hub;
  const dir = yield* repoDir;
  return {
    repo: 'o/r',
    revision: hub.shaOf('o/r'),
    key,
    name: Str.replace(/\.gguf$/, '')(key),
    quant: null,
    kind: 'model',
    dir,
    files: Arr.map(files, ([path, body]) => ({ path, size: body.length, sha256: sha256 ?? hexOf(body) })),
  } satisfies NewDownload;
});

/** `m.gguf` of `size` bytes, served. */
const single = Effect.fnUntraced(function* (size = 4000) {
  const body = data(size);
  const files: Files = [['m.gguf', body]];
  yield* serve(files);
  return { body, input: yield* input('m.gguf', files) };
});

const destOf = (file: string) => Effect.map(repoDir, (dir) => `${dir}/${file}`);

/** Writes `bytes` as the `.part` of `file`. */
const writePart = Effect.fnUntraced(function* (file: string, bytes: Uint8Array) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dest = yield* destOf(file);
  yield* fs.makeDirectory(path.dirname(dest), { recursive: true });
  yield* fs.writeFile(partPath(dest), bytes);
}, Effect.orDie);

const partSize = Effect.fnUntraced(function* (file: string) {
  const dest = yield* destOf(file);
  const size = yield* sizeOf(partPath(dest));
  return Option.getOrElse(size, () => -1);
});

const exists = Effect.fnUntraced(function* (file: string) {
  const fs = yield* FileSystem.FileSystem;
  const dest = yield* destOf(file);
  return yield* fs.exists(dest);
}, Effect.orDie);

/** Fails the test unless `file` is in place with `body` and no `.part` is left. */
const expectPlaced = Effect.fnUntraced(function* (file: string, body: Uint8Array) {
  const fs = yield* FileSystem.FileSystem;
  const dest = yield* destOf(file);
  const got = yield* fs.readFile(dest);
  assert.strictEqual(got.length, body.length);
  assert.strictEqual(hexOf(got), hexOf(body));
  const part = yield* fs.exists(partPath(dest));
  assert.isFalse(part);
}, Effect.orDie);

/** Waits (real time, 5 s at most) until `check` holds. */
const eventually = Effect.fnUntraced(
  function* <R>(check: Effect.Effect<boolean, never, R>) {
    while (!(yield* check)) yield* Effect.sleep('10 millis');
  },
  Effect.timeout('5 seconds'),
  Effect.orDie,
);

/** The same on the `TestClock`: the polling on the live clock. */
const eventuallyLive = <R>(check: Effect.Effect<boolean, never, R>) => TestClock.withLive(eventually(check));

/** A live pause, for a fiber woken by a message to get to its next sleep. */
const settle = TestClock.withLive(Effect.sleep('20 millis'));

const itemOf = Effect.fnUntraced(function* (id: number) {
  const repo = yield* DownloadsRepo;
  const item = yield* repo.get(id);
  return Option.getOrThrow(item);
});

const isFinished = (id: number) =>
  Effect.map(itemOf(id), (item) => item.status === 'done' || item.status === 'error' || item.status === 'canceled');

/** Queues `of` and gives the item it made. */
const enqueue = Effect.fnUntraced(function* (of: NewDownload) {
  const downloads = yield* Downloads;
  const [item] = yield* downloads.enqueue([of]);
  if (item === undefined) return yield* Effect.die('nothing was queued');
  return item;
});

/** Queues `of`, waits (real time) until it ends, and gives the item as it ended. */
const download = Effect.fnUntraced(function* (of: NewDownload) {
  const item = yield* enqueue(of);
  yield* eventually(isFinished(item.id));
  return yield* itemOf(item.id);
});

const reaches = (id: number, status: DownloadItem['status']) =>
  eventually(Effect.map(itemOf(id), (item) => item.status === status));

/** The statuses published for item `id`, in order. */
const statuses = Effect.fnUntraced(function* (id: number) {
  const published = yield* Published;
  const all = yield* Ref.get(published);
  return Arr.flatMap(all, (message) =>
    message.type === 'download' && message.payload.id === id ? [message.payload.status] : [],
  );
});

/** The live progress published, in order (null once an item ended). */
const lives = Effect.gen(function* () {
  const published = yield* Published;
  const all = yield* Ref.get(published);
  return Arr.flatMap(
    all,
    (message): ReadonlyArray<DownloadLive | null> => (message.type === 'download-progress' ? [message.payload] : []),
  );
});

const retrying = Effect.map(lives, (all) =>
  Arr.flatMap(all, (live) => (live !== null && live.phase === 'retrying' ? [live] : [])),
);

/** The requests of `route` the fake Hub saw. */
const requestsOf = (route: 'resolve' | 'cdn') =>
  Effect.map(Hub, (hub) => Arr.filter(hub.requests(), (request) => request.route === route));

/** The `Range` headers of the CDN requests, in order. */
const ranges = Effect.map(requestsOf('cdn'), (requests) => Arr.map(requests, (request) => request.headers.range));

const failOn = (route: 'resolve' | 'cdn', fault: Parameters<FakeHub['fail']>[1], times?: number) =>
  Effect.map(Hub, (hub) => hub.fail(route, fault, times));

const expectEqual = <A, E, R>(effect: Effect.Effect<A, E, R>, expected: A) =>
  Effect.map(effect, (actual) => assert.deepStrictEqual(actual, expected));

/** The text logged at `level` so far. */
const logged = (level: 'Error' | 'Warn') => Arr.flatMap(logs, ([at, text]) => (at === level ? [text] : []));

/** The `TransferFailed` of the transfer of `of` run alone (no queue, its row removed after), `report` ignored. */
const transferFailure = Effect.fnUntraced(function* (of: NewDownload) {
  const repo = yield* DownloadsRepo;
  const item = yield* repo.create(of);
  const failure = yield* Effect.flip(transferItem(item, () => Effect.void));
  // Out of the database, for a queue of the test not to run it.
  yield* repo.remove(item.id);
  return failure;
});

/** A file system whose writes to an open file fail with ENOSPC. */
const fullDisk = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const enospc = PlatformError.systemError({
    _tag: 'Unknown',
    module: 'FileSystem',
    method: 'writeAll',
    cause: Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' }),
  });
  return FileSystem.FileSystem.of({
    ...fs,
    open: (path, options) =>
      Effect.map(
        fs.open(path, options),
        (file): FileSystem.File => ({
          [FileSystem.FileTypeId]: FileSystem.FileTypeId,
          get stat() {
            return file.stat;
          },
          get sync() {
            return file.sync;
          },
          seek: (offset, from) => file.seek(offset, from),
          read: (buffer, readOptions) => file.read(buffer, readOptions),
          readAlloc: (size, readOptions) => file.readAlloc(size, readOptions),
          truncate: (length) => file.truncate(length),
          write: () => Effect.fail(enospc),
          writeAll: () => Effect.fail(enospc),
        }),
      ),
  });
});

layer(Base, { excludeTestServices: true, buildPerTest: true })('transfer', (it) => {
  it.effect('downloads every shard, checks it and renames it into place; the token never reaches the CDN', () =>
    withQueue(
      Effect.gen(function* () {
        const hub = yield* Hub;
        const first = data(3000, 1);
        const second = data(2000, 2);
        const files: Files = [
          ['Q8/m-00001-of-00002.gguf', first],
          ['Q8/m-00002-of-00002.gguf', second],
        ];
        yield* serve(files);
        const item = yield* Effect.flatMap(input('Q8', files), download);
        assert.strictEqual(item.status, 'done');
        assert.strictEqual(item.bytesDone, 5000);
        yield* expectEqual(statuses(item.id), ['queued', 'downloading', 'done']);
        yield* expectPlaced('Q8/m-00001-of-00002.gguf', first);
        yield* expectPlaced('Q8/m-00002-of-00002.gguf', second);
        const sha = hub.shaOf('o/r');
        const resolves = yield* requestsOf('resolve');
        assert.deepStrictEqual(
          Arr.map(resolves, (request) => request.url),
          [`/o/r/resolve/${sha}/Q8/m-00001-of-00002.gguf`, `/o/r/resolve/${sha}/Q8/m-00002-of-00002.gguf`],
        );
        for (const request of resolves) {
          assert.strictEqual(request.headers.authorization, 'Bearer hf_secret');
          assert.strictEqual(request.headers['user-agent'], 'llama-webui');
        }
        const cdn = yield* requestsOf('cdn');
        assert.strictEqual(cdn.length, 2);
        for (const request of cdn) assert.isUndefined(request.headers.authorization);
        const all = yield* lives;
        assert.isNull(Arr.last(all).pipe(Option.getOrThrow));
        assert.isTrue(Arr.some(all, (live) => live !== null && live.bytesDone === 5000));
      }),
    ),
  );

  it.effect('resumes an existing .part with a Range request', () =>
    withQueue(
      Effect.gen(function* () {
        const { body, input: m } = yield* single();
        yield* writePart('m.gguf', body.subarray(0, 1500));
        const item = yield* download(m);
        assert.strictEqual(item.status, 'done');
        yield* expectPlaced('m.gguf', body);
        yield* expectEqual(ranges, ['bytes=1500-']);
      }),
    ),
  );

  it.effect('starts over when the server ignores the Range header', () =>
    withQueue(
      Effect.gen(function* () {
        const { body, input: m } = yield* single();
        // Not the file's first bytes: only a write from zero gives the right file and digest.
        yield* writePart('m.gguf', data(1500, 9));
        yield* failOn('cdn', { status: 200, headers: { 'content-length': '4000' }, body });
        const item = yield* download(m);
        assert.strictEqual(item.status, 'done');
        yield* expectPlaced('m.gguf', body);
        yield* expectEqual(ranges, ['bytes=1500-']);
      }),
    ),
  );

  it.effect('a connection cut mid-file is resumed where it stopped', () =>
    withQueue(
      Effect.gen(function* () {
        const { body, input: m } = yield* single();
        yield* failOn('cdn', { cut: 2000 });
        const item = yield* download(m);
        assert.strictEqual(item.status, 'done');
        yield* expectPlaced('m.gguf', body);
        yield* expectEqual(ranges, [undefined, 'bytes=2000-']);
      }),
    ),
  );

  it.effect('a body that ends early without an error is resumed, not started over; the hash is not read again', () =>
    withQueue(
      Effect.gen(function* () {
        const { body, input: m } = yield* single();
        yield* failOn('cdn', { status: 200, headers: { 'content-length': '2000' }, body: body.subarray(0, 2000) });
        const item = yield* download(m);
        assert.strictEqual(item.status, 'done');
        yield* expectPlaced('m.gguf', body);
        yield* expectEqual(ranges, [undefined, 'bytes=2000-']);
        const all = yield* lives;
        assert.isFalse(Arr.some(all, (live) => live !== null && live.phase === 'verifying'));
      }),
    ),
  );

  it.effect('network errors are retried, then the item fails once the retries are spent', () =>
    withQueue(
      Effect.gen(function* () {
        const a = data(1000, 1);
        const b = data(1000, 2);
        yield* serve([
          ['a.gguf', a],
          ['b.gguf', b],
        ]);
        yield* failOn('resolve', { drop: true }, 2);
        const first = yield* Effect.flatMap(input('a.gguf', [['a.gguf', a]]), download);
        assert.strictEqual(first.status, 'done');
        yield* expectPlaced('a.gguf', a);
        yield* expectEqual(Effect.map(retrying, Arr.length), 2);
        yield* failOn('resolve', { drop: true }, 6);
        const before = (yield* requestsOf('resolve')).length;
        const second = yield* Effect.flatMap(input('b.gguf', [['b.gguf', b]]), download);
        assert.strictEqual(second.status, 'error');
        assert.strictEqual(second.code, 'hf-unreachable');
        assert.isTrue(Str.startsWith('Hugging Face unreachable: ')(second.error ?? ''));
        yield* expectEqual(
          Effect.map(requestsOf('resolve'), (requests) => requests.length - before),
          6,
        );
      }),
    ),
  );

  it.effect('a gated repo fails at once, with its code', () =>
    withQueue(
      Effect.gen(function* () {
        const { input: m } = yield* single();
        yield* failOn('resolve', { status: 403, headers: { 'x-error-code': 'GatedRepo' } });
        const item = yield* download(m);
        assert.strictEqual(item.status, 'error');
        assert.strictEqual(item.code, 'hf-gated');
        assert.strictEqual(item.error, 'o/r is gated: accept its license on Hugging Face');
        yield* expectEqual(Effect.map(requestsOf('resolve'), Arr.length), 1);
        yield* expectEqual(Effect.map(requestsOf('cdn'), Arr.length), 0);
      }),
    ),
  );

  it.effect('a checksum mismatch deletes the file', () =>
    withQueue(
      Effect.gen(function* () {
        const body = data(4000);
        const files: Files = [['m.gguf', body]];
        yield* serve(files);
        const item = yield* Effect.flatMap(input('m.gguf', files, Str.repeat(64)('f')), download);
        assert.strictEqual(item.status, 'error');
        assert.strictEqual(item.code, 'checksum-mismatch');
        assert.strictEqual(item.error, 'Checksum mismatch for m.gguf: the file was deleted');
        yield* expectEqual(exists('m.gguf'), false);
        yield* expectEqual(partSize('m.gguf'), -1);
      }),
    ),
  );

  it.effect('retrying a canceled split model downloads again the shards the cancel deleted', () =>
    withQueue(
      Effect.gen(function* () {
        const downloads = yield* Downloads;
        const first = data(2000, 1);
        const second = data(2000, 2);
        const files: Files = [
          ['m-00001-of-00002.gguf', first],
          ['m-00002-of-00002.gguf', second],
        ];
        yield* serve(files);
        // The first shard goes through, the second stalls after 500 bytes.
        yield* failOn('cdn', { pass: true });
        yield* failOn('cdn', { stall: 500 });
        const item = yield* Effect.flatMap(input('m', files), enqueue);
        yield* eventually(Effect.map(partSize('m-00002-of-00002.gguf'), (size) => size === 500));
        const running = yield* itemOf(item.id);
        assert.deepStrictEqual(
          Arr.map(running.files, (file) => file.done),
          [true, false],
        );
        yield* downloads.remove(item.id);
        yield* reaches(item.id, 'canceled');
        yield* expectEqual(exists('m-00001-of-00002.gguf'), false);
        yield* downloads.retry(item.id);
        yield* reaches(item.id, 'done');
        yield* expectPlaced('m-00001-of-00002.gguf', first);
        yield* expectPlaced('m-00002-of-00002.gguf', second);
        yield* expectEqual(
          Effect.map(itemOf(item.id), (done) => done.bytesDone),
          4000,
        );
      }),
    ),
  );

  it.effect('after a restart, the next queue resumes the item from its .part', () =>
    Effect.gen(function* () {
      const { body, input: m } = yield* single(5000);
      yield* failOn('cdn', { stall: 2500 });
      // The first run: stopped by its own shutdown steps while the body stalls (fresh: not the registry of the base).
      const item = yield* Layer.build(Queued().pipe(Layer.provideMerge(Layer.fresh(Shutdown.layer)))).pipe(
        Effect.flatMap((context) =>
          Effect.provideContext(
            Effect.gen(function* () {
              const shutdown = yield* Shutdown;
              const queued = yield* enqueue(m);
              yield* eventually(Effect.map(partSize('m.gguf'), (size) => size === 2500));
              yield* shutdown.run;
              return queued;
            }),
            context,
          ),
        ),
        Effect.scoped,
      );
      yield* expectEqual(
        Effect.map(itemOf(item.id), (stopped) => stopped.status),
        'downloading',
      );
      yield* expectEqual(statuses(item.id), ['queued', 'downloading']);
      const stopped = yield* lives;
      assert.isNotNull(Arr.last(stopped).pipe(Option.getOrThrow));
      yield* expectEqual(partSize('m.gguf'), 2500);
      // The next run, on the same database and folder.
      yield* withQueue(reaches(item.id, 'done'));
      yield* expectPlaced('m.gguf', body);
      yield* expectEqual(ranges, [undefined, 'bytes=2500-']);
    }),
  );

  it.effect('a seventh redirect fails the item with Too many redirects from Hugging Face', () =>
    withQueue(
      Effect.gen(function* () {
        const hub = yield* Hub;
        const { body, input: m } = yield* single();
        const location = `/o/r/resolve/${hub.shaOf('o/r')}/m.gguf`;
        // Five more before the Hub's own: six redirects are followed.
        yield* failOn('resolve', { status: 302, headers: { location } }, 5);
        const item = yield* download(m);
        assert.strictEqual(item.status, 'done');
        yield* expectPlaced('m.gguf', body);
        yield* expectEqual(Effect.map(requestsOf('resolve'), Arr.length), 6);
        // The relative redirects stay on the endpoint's origin: each hop carries the token.
        for (const request of yield* requestsOf('resolve')) {
          assert.strictEqual(request.headers.authorization, 'Bearer hf_secret');
        }
        const fs = yield* FileSystem.FileSystem;
        yield* destOf('m.gguf').pipe(
          Effect.flatMap((dest) => fs.remove(dest)),
          Effect.orDie,
        );
        // Six more: the Hub's own is the seventh.
        yield* failOn('resolve', { status: 302, headers: { location } }, 6);
        const failure = yield* transferFailure(m);
        assert.deepStrictEqual(
          failure,
          TransferFailed.make({ message: 'Too many redirects from Hugging Face', code: 'hf-unreachable', status: 502 }),
        );
        yield* expectEqual(Effect.map(requestsOf('resolve'), Arr.length), 13);
        yield* expectEqual(Effect.map(requestsOf('cdn'), Arr.length), 1);
        // Through the queue: the item fails at once with it.
        yield* failOn('resolve', { status: 302, headers: { location } }, 6);
        const queued = yield* download(m);
        assert.strictEqual(queued.status, 'error');
        assert.strictEqual(queued.code, 'hf-unreachable');
        assert.strictEqual(queued.error, 'Too many redirects from Hugging Face');
      }),
    ),
  );

  it.effect('a 416 deletes the .part and starts the file from zero', () =>
    withQueue(
      Effect.gen(function* () {
        const { body, input: m } = yield* single();
        yield* writePart('m.gguf', body.subarray(0, 1500));
        yield* failOn('cdn', { status: 416, headers: { 'content-range': 'bytes */4000' } });
        const item = yield* download(m);
        assert.strictEqual(item.status, 'done');
        yield* expectPlaced('m.gguf', body);
        yield* expectEqual(ranges, ['bytes=1500-', undefined]);
      }),
    ),
  );

  it.effect('a 206 that does not start at the offset deletes the .part and retries', () =>
    withQueue(
      Effect.gen(function* () {
        const { body, input: m } = yield* single();
        yield* writePart('m.gguf', body.subarray(0, 1500));
        yield* failOn('cdn', { status: 206, headers: { 'content-range': 'bytes 0-3999/4000' }, body });
        const item = yield* download(m);
        assert.strictEqual(item.status, 'done');
        yield* expectPlaced('m.gguf', body);
        yield* expectEqual(ranges, ['bytes=1500-', undefined]);
      }),
    ),
  );

  it.effect('a .part larger than the file is deleted before the request', () =>
    withQueue(
      Effect.gen(function* () {
        const { body, input: m } = yield* single();
        yield* writePart('m.gguf', data(5000, 3));
        const item = yield* download(m);
        assert.strictEqual(item.status, 'done');
        yield* expectPlaced('m.gguf', body);
        yield* expectEqual(ranges, [undefined]);
      }),
    ),
  );

  it.effect('a body longer than the file deletes the .part and retries', () =>
    withQueue(
      Effect.gen(function* () {
        logs.length = 0;
        const { body, input: m } = yield* single();
        yield* failOn('cdn', { status: 200, body: data(5000, 4) });
        const item = yield* download(m);
        assert.strictEqual(item.status, 'done');
        yield* expectPlaced('m.gguf', body);
        yield* expectEqual(ranges, [undefined, undefined]);
        assert.include(logged('Warn'), '[llama-webui] download o/r/m.gguf: m.gguf: got 5000 of 4000 bytes, retrying');
      }),
    ),
  );

  it.effect('408, 429 and 5xx answers are retried', () =>
    withQueue(
      Effect.gen(function* () {
        const { body, input: m } = yield* single();
        yield* failOn('resolve', { status: 408 });
        yield* failOn('resolve', { status: 429 });
        yield* failOn('resolve', { status: 503 });
        yield* failOn('cdn', { status: 500 });
        yield* failOn('cdn', { status: 502 });
        // Five failures: the whole budget, the sixth attempt goes through.
        const item = yield* download(m);
        assert.strictEqual(item.status, 'done');
        yield* expectPlaced('m.gguf', body);
        yield* expectEqual(Effect.map(retrying, Arr.length), 5);
        yield* expectEqual(Effect.map(requestsOf('resolve'), Arr.length), 6);
        yield* expectEqual(Effect.map(requestsOf('cdn'), Arr.length), 3);
      }),
    ),
  );

  it.effect('ENOSPC fails the item with 507 Disk full', () =>
    Effect.gen(function* () {
      const fs = yield* fullDisk;
      const { input: m } = yield* single();
      const failure = yield* transferFailure(m).pipe(Effect.provideService(FileSystem.FileSystem, fs));
      assert.deepStrictEqual(failure, TransferFailed.make({ message: 'Disk full', code: 'disk-full', status: 507 }));
      yield* expectEqual(Effect.map(requestsOf('cdn'), Arr.length), 1);
      const item = yield* withQueue(download(m), { fs });
      assert.strictEqual(item.status, 'error');
      assert.strictEqual(item.code, 'disk-full');
      assert.strictEqual(item.error, 'Disk full');
      // Not retried.
      yield* expectEqual(Effect.map(requestsOf('cdn'), Arr.length), 2);
    }),
  );

  it.effect('a local error fails the item with download-failed and is logged failed', () =>
    withQueue(
      Effect.gen(function* () {
        logs.length = 0;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { input: m } = yield* single();
        // The repository's folder is a file: no folder can be made there.
        const dir = yield* repoDir;
        yield* Effect.orDie(fs.makeDirectory(path.dirname(dir), { recursive: true }));
        yield* Effect.orDie(fs.writeFileString(dir, 'not a folder'));
        const item = yield* download(m);
        assert.strictEqual(item.status, 'error');
        assert.strictEqual(item.code, 'download-failed');
        assert.isTrue(Str.isNonEmpty(item.error ?? ''));
        assert.include(logged('Error'), `[llama-webui] download o/r/m.gguf failed: ${item.error}`);
        yield* expectEqual(Effect.map(requestsOf('resolve'), Arr.length), 0);
      }),
    ),
  );

  it.effect('a retry is logged retrying with the file and the message', () =>
    withQueue(
      Effect.gen(function* () {
        logs.length = 0;
        const { input: m } = yield* single();
        yield* failOn('cdn', { status: 503 });
        const item = yield* download(m);
        assert.strictEqual(item.status, 'done');
        assert.deepStrictEqual(logged('Warn'), ['[llama-webui] download o/r/m.gguf: Hugging Face error 503, retrying']);
      }),
    ),
  );

  it.effect('the verifying re-read hashes exactly the .part, in 1 MiB chunks', () =>
    Effect.gen(function* () {
      const real = yield* FileSystem.FileSystem;
      const chunks: Array<number> = [];
      const fs = FileSystem.FileSystem.of({
        ...real,
        stream: (file, options) =>
          real.stream(file, options).pipe(Stream.tap((chunk) => Effect.sync(() => chunks.push(chunk.byteLength)))),
      });
      const { body, input: m } = yield* single(3 * MiB);
      const left = (5 * MiB) / 2;
      yield* writePart('m.gguf', body.subarray(0, left));
      const item = yield* withQueue(download(m), { fs });
      assert.strictEqual(item.status, 'done');
      assert.deepStrictEqual(chunks, [MiB, MiB, MiB / 2]);
      yield* expectPlaced('m.gguf', body);
      yield* expectEqual(ranges, [`bytes=${left}-`]);
      const all = yield* lives;
      assert.isTrue(Arr.some(all, (live) => live !== null && live.phase === 'verifying' && live.bytesDone === left));
    }),
  );
});

layer(Base, { buildPerTest: true })('transfer on the TestClock', (it) => {
  /** Waits until `n` `retrying` were published, checks the last one's `retryAt` is `ms` away, then lets it pass. */
  const pause = Effect.fnUntraced(function* (n: number, ms: number) {
    yield* eventuallyLive(Effect.map(retrying, (all) => all.length >= n));
    const all = yield* retrying;
    const now = yield* Clock.currentTimeMillis;
    const last = Option.getOrThrow(Arr.last(all));
    assert.strictEqual((last.retryAt ?? 0) - now, ms);
    yield* settle;
    yield* TestClock.adjust(ms);
  });

  it.effect('the retry budget is reset after an attempt that received data', () =>
    withQueue(
      Effect.gen(function* () {
        const { body, input: m } = yield* single(1000);
        // Six failures, each after 100 bytes: every pause is the first one.
        yield* failOn('cdn', { cut: 100 }, 6);
        const item = yield* enqueue(m);
        for (let n = 1; n <= 6; n++) yield* pause(n, 2000);
        yield* eventuallyLive(isFinished(item.id));
        yield* expectEqual(
          Effect.map(itemOf(item.id), (done) => done.status),
          'done',
        );
        yield* expectPlaced('m.gguf', body);
      }),
      { appTiming: true },
    ),
  );

  it.effect(
    'a body longer than the file does not reset the retry budget: a server that always oversends fails the item',
    () =>
      withQueue(
        Effect.gen(function* () {
          const { input: m } = yield* single(1000);
          yield* failOn('cdn', { status: 200, body: data(2000, 4) }, 6);
          const item = yield* enqueue(m);
          let n = 0;
          for (const ms of [2000, 4000, 8000, 16000, 30000]) {
            n++;
            yield* pause(n, ms);
          }
          yield* eventuallyLive(isFinished(item.id));
          const failed = yield* itemOf(item.id);
          assert.strictEqual(failed.status, 'error');
          assert.strictEqual(failed.code, 'hf-unreachable');
          assert.strictEqual(failed.error, 'm.gguf: got 2000 of 1000 bytes');
          yield* expectEqual(Effect.map(requestsOf('cdn'), Arr.length), 6);
        }),
        { appTiming: true },
      ),
  );

  it.effect('no data for 60 s is retried as no data for 60 s', () =>
    withQueue(
      Effect.gen(function* () {
        logs.length = 0;
        const { body, input: m } = yield* single();
        yield* failOn('cdn', { stall: 1000 });
        const item = yield* enqueue(m);
        // The headers and the first bytes are in: the body is silent from there.
        yield* eventuallyLive(Effect.map(partSize('m.gguf'), (size) => size === 1000));
        for (let tries = 0; (yield* retrying).length === 0; tries++) {
          if (tries === 10) return assert.fail('no retry after 10 minutes');
          yield* settle;
          yield* TestClock.adjust('60 seconds');
        }
        assert.include(logged('Warn'), '[llama-webui] download o/r/m.gguf: no data for 60 s, retrying');
        yield* settle;
        yield* TestClock.adjust('2 seconds');
        yield* eventuallyLive(isFinished(item.id));
        yield* expectEqual(
          Effect.map(itemOf(item.id), (done) => done.status),
          'done',
        );
        yield* expectPlaced('m.gguf', body);
        yield* expectEqual(ranges, [undefined, 'bytes=1000-']);
      }),
      { appTiming: true },
    ),
  );

  it.effect('the pauses are 2, 4, 8, 16 then 30 s, each published as retrying with its retryAt', () =>
    withQueue(
      Effect.gen(function* () {
        const { input: m } = yield* single();
        yield* failOn('cdn', { status: 503 }, 6);
        const item = yield* enqueue(m);
        let n = 0;
        for (const ms of [2000, 4000, 8000, 16000, 30000]) {
          n++;
          yield* pause(n, ms);
        }
        yield* eventuallyLive(isFinished(item.id));
        const failed = yield* itemOf(item.id);
        assert.strictEqual(failed.status, 'error');
        assert.strictEqual(failed.code, 'hf-unreachable');
        assert.strictEqual(failed.error, 'Hugging Face error 503');
        yield* expectEqual(Effect.map(retrying, Arr.length), 5);
      }),
      { appTiming: true },
    ),
  );

  it.effect('progress is published at most once per 250 ms with a smoothed bps', () => {
    const at = (report: Parameters<Transfer>[1], phase: DownloadLive['phase'], bytesDone: number, throttled: boolean) =>
      report({ phase, file: 'm.gguf', bytesDone, retryAt: null, throttled });
    const scripted: Transfer = Effect.fnUntraced(function* (_item, report) {
      yield* at(report, 'downloading', 0, false);
      yield* TestClock.adjust('100 millis');
      yield* at(report, 'downloading', 1000, true);
      yield* TestClock.adjust('150 millis');
      yield* at(report, 'downloading', 2500, true);
      yield* TestClock.adjust('100 millis');
      yield* at(report, 'downloading', 3000, true);
      yield* TestClock.adjust('400 millis');
      yield* at(report, 'downloading', 10000, true);
      yield* at(report, 'verifying', 10000, false);
    });
    return withQueue(
      Effect.gen(function* () {
        const { input: m } = yield* single(10000);
        const item = yield* enqueue(m);
        yield* eventuallyLive(isFinished(item.id));
        const all = yield* lives;
        assert.deepStrictEqual(
          Arr.map(all, (live) => (live === null ? null : [live.phase, live.bytesDone, Math.round(live.bps)])),
          [
            // The item's start, then the transfer's.
            ['downloading', 0, 0],
            ['downloading', 0, 0],
            ['downloading', 2500, 10000],
            ['downloading', 10000, 11500],
            ['verifying', 10000, 0],
            null,
          ],
        );
      }),
      { transfer: scripted, liveEvery: '250 millis' },
    );
  });
});
