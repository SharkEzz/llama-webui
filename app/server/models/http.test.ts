import { NodeServices } from '@effect/platform-node';
import { assert, describe, layer } from '@effect/vitest';
import { type DownloadItem, ModelDetail, ModelList, type ModelUsage, type ServerState } from '@llama-webui/shared';
import {
  Array as Arr,
  Clock,
  ConfigProvider,
  Context,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  PlatformError,
  Ref,
  Schedule,
  Schema,
  String as Str,
} from 'effect';
import { HttpClient, HttpClientRequest } from 'effect/http';
import { ApiRoutes, serve } from '../http/HttpLive.ts';
import { ProfilesRepo } from '../profiles/ProfilesRepo.ts';
import { SettingsRepo } from '../settings/SettingsRepo.ts';
import { Supervisor } from '../supervisor/Supervisor.ts';
import { type FakeTensor, type KvValue, writeGguf } from '../testing/gguf.ts';
import { ServerTest } from '../testing/http.ts';
import { FAKE, freePort, pidAlive } from '../testing/llama.ts';
import { ServicesTest } from '../testing/services.ts';
import { ActiveWrites } from './ActiveWrites.ts';

const u32 = (value: number): KvValue => ({ type: 'u32', value });
const str = (value: string): KvValue => ({ type: 'string', value });

const LLAMA: Record<string, KvValue> = {
  'general.architecture': str('llama'),
  'general.name': str('Tiny'),
  'general.file_type': u32(15),
  'llama.block_count': u32(2),
  'llama.embedding_length': u32(64),
  'llama.attention.head_count': u32(4),
  'llama.attention.head_count_kv': u32(2),
  'llama.context_length': u32(4096),
  'llama.vocab_size': u32(100),
};
const TENSORS: FakeTensor[] = [
  { name: 'token_embd.weight', shape: [64, 100], bytes: 6400 },
  { name: 'blk.0.attn_q.weight', shape: [64, 64], bytes: 4096 },
  { name: 'blk.0.ffn_up.weight', shape: [64, 128], bytes: 8192 },
  { name: 'blk.1.attn_q.weight', shape: [64, 64], bytes: 4096 },
  { name: 'blk.1.ffn_up.weight', shape: [64, 128], bytes: 8192 },
  { name: 'output_norm.weight', shape: [64], bytes: 64 },
  { name: 'output.weight', shape: [64, 100], bytes: 6400 },
];
const MMPROJ: Record<string, KvValue> = { 'general.architecture': str('clip'), 'general.type': str('mmproj') };

/** The home of the test (`HOME`): the models folder is the default `~/models` under it. */
class Home extends Context.Service<Home, string>()('@llama-webui/app/server/models/http.test/Home') {}

/** The items the download queue writes, as the test sets them. */
class Writes extends Context.Service<Writes, Ref.Ref<ReadonlyArray<DownloadItem>>>()(
  '@llama-webui/app/server/models/http.test/Writes',
) {}

/** A shard the file system refuses to remove. */
const STUCK = 'Stuck-00002-of-00002.gguf';

/** Node's file system, but `remove` of a `STUCK` file fails as a refused permission. */
const StuckFs = Layer.effect(
  FileSystem.FileSystem,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const paths = yield* Path.Path;
    return FileSystem.FileSystem.of({
      ...fs,
      remove: (file, options) =>
        paths.basename(file) === STUCK
          ? Effect.fail(
              PlatformError.systemError({
                _tag: 'PermissionDenied',
                module: 'FileSystem',
                method: 'remove',
                pathOrDescriptor: file,
              }),
            )
          : fs.remove(file, options),
    });
  }),
);

/** The download queue's active items are what `Writes` holds. */
const TestWrites = Layer.effect(
  ActiveWrites,
  Effect.gen(function* () {
    const writes = yield* Writes;
    return ActiveWrites.of({ active: Ref.get(writes) });
  }),
);

/** `HOME` is a temporary folder of the test's own (removed at its end); the rest of the configuration as it is. */
const HomeConfig = ConfigProvider.layerAdd(
  Effect.gen(function* () {
    const home = yield* Home;
    return ConfigProvider.fromUnknown({ HOME: home });
  }),
  { asPrimary: true },
).pipe(
  Layer.provideMerge(
    Layer.effect(
      Home,
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        return yield* fs.makeTempDirectoryScoped({ prefix: 'lw-models-' });
      }),
    ),
  ),
);

/**
 * The API as the app serves it, on a real server and the services of the app, a home of its own, the download queue's
 * items of `Writes` and a file system that cannot remove a `STUCK` shard.
 */
const Served = serve(ApiRoutes).pipe(
  Layer.provide(Layer.mergeAll(StuckFs, TestWrites)),
  Layer.provideMerge(Layer.effect(Writes, Ref.make<ReadonlyArray<DownloadItem>>([]))),
  Layer.provideMerge(ServicesTest),
  Layer.provideMerge(ServerTest),
  Layer.provideMerge(HomeConfig),
  Layer.provideMerge(NodeServices.layer),
);

const parseJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

/** The status and (when it is JSON) the value of a raw reply. */
const send = (method: 'GET' | 'POST' | 'DELETE', path: string, body?: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const base = HttpClientRequest.make(method)(path);
    const request = body === undefined ? base : HttpClientRequest.bodyText(base, body, 'application/json');
    const res = yield* client.execute(request);
    const text = yield* res.text;
    const isJson = Option.exists(Option.fromNullishOr(res.headers['content-type']), Str.startsWith('application/json'));
    const json: unknown = isJson && Str.isNonEmpty(text) ? yield* parseJson(text) : undefined;
    return { status: res.status, json };
  });

/** A JSON reply as the schema reads it: a reply of another shape fails the test. */
const as = <A, I>(schema: Schema.Codec<A, I>, json: unknown) => Schema.decodeUnknownEffect(schema)(json);

const usageOf = (path: string) => send('GET', `/api/models/usage?path=${encodeURIComponent(path)}`);
const remove = (path: string, deleteProfiles: boolean) =>
  encodeJson({ path, deleteProfiles }).pipe(Effect.flatMap((body) => send('DELETE', '/api/models', body)));
const infoOf = (path: string) => send('GET', `/api/models/info?path=${encodeURIComponent(path)}`);

const notFound = { _tag: 'ModelNotFound', message: 'Model not found' };
const fileNotFound = { _tag: 'ModelFileNotFound', message: 'File not found' };

/**
 * The models folder (`~/models`, not made yet) and ways to fill it: GGUFs (`write`), any bytes (`writeText`), and the
 * split model `org/Big` of two parts, `small.gguf` and the projector `mm.gguf` (`seed`).
 */
const workspace = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const paths = yield* Path.Path;
  const home = yield* Home;
  const models = paths.join(home, 'models');
  const at = (rel: string) => paths.join(models, rel);
  /** Writes a GGUF at `file` (its folders made) and gives its path. */
  const writeAt = (file: string, kv: Record<string, KvValue> = LLAMA, tensors: FakeTensor[] = TENSORS) =>
    Effect.gen(function* () {
      yield* fs.makeDirectory(paths.dirname(file), { recursive: true });
      yield* Effect.promise(() => writeGguf(file, kv, tensors));
      return file;
    });
  const write = (rel: string, kv?: Record<string, KvValue>) => writeAt(at(rel), kv);
  const writeText = (file: string, text: string) =>
    Effect.gen(function* () {
      yield* fs.makeDirectory(paths.dirname(file), { recursive: true });
      yield* fs.writeFileString(file, text);
      return file;
    });
  const seed = Effect.gen(function* () {
    const big = [yield* write('org/Big/Big-00001-of-00002.gguf'), yield* write('org/Big/Big-00002-of-00002.gguf')];
    const small = yield* write('small.gguf');
    const mm = yield* write('mm.gguf', MMPROJ);
    return { big, small, mm };
  });
  return { fs, paths, home, models, at, write, writeAt, writeText, seed };
});

/** The ids of the profiles, in the repository's order. */
const profileIds = Effect.gen(function* () {
  const repo = yield* ProfilesRepo;
  const all = yield* repo.list;
  return Arr.map(all, (p) => p.id);
});

/** The smallest profile input. */
const profile = (name: string, more: { cwd?: string; model?: string; mmproj?: string; port?: number } = {}) => ({
  name,
  model: 'm.gguf',
  args: [],
  env: {},
  ...more,
});

/** Waits until the supervisor is in `kind` (looked at every 10 ms, for 5 s at most). */
const stateWhen = (supervisor: Supervisor['Service'], kind: ServerState['kind']) =>
  supervisor.state.pipe(
    Effect.repeat({ schedule: Schedule.spaced('10 millis'), until: (state) => state.kind === kind }),
    Effect.timeout('5 seconds'),
  );

/** A download of the queue writing `files` into `dir`. */
const downloading = (dir: string, files: ReadonlyArray<string>): DownloadItem => ({
  id: 1,
  repo: 'org/repo',
  revision: 'main',
  key: files[0] ?? '',
  name: 'repo',
  quant: null,
  kind: 'model',
  dir,
  files: Arr.map(files, (path) => ({ path, size: 1, sha256: null, done: false })),
  status: 'downloading',
  bytesDone: 0,
  totalBytes: 1,
  error: null,
  code: null,
  createdAt: 0,
  finishedAt: null,
});

describe('ModelsApi', () => {
  // On the real clock (the supervisor polls `/health`, `scannedAt` is the time of the scan), each test on its own app.
  layer(Served, { excludeTestServices: true, buildPerTest: true })('over HTTP', (it) => {
    it.effect('the list holds the scan with dir, setting, home and scannedAt', () =>
      Effect.gen(function* () {
        const { home, models, seed } = yield* workspace;
        yield* seed;
        const before = yield* Clock.currentTimeMillis;
        const reply = yield* send('GET', '/api/models');
        assert.strictEqual(reply.status, 200);
        const list = yield* as(ModelList, reply.json);
        assert.deepStrictEqual(
          { dir: list.dir, setting: list.setting, home: list.home },
          { dir: models, setting: '~/models', home },
        );
        const after = yield* Clock.currentTimeMillis;
        assert.isTrue(list.scannedAt >= before && list.scannedAt <= after);
        assert.deepStrictEqual(
          Arr.map(list.models, (m) => [m.relPath, m.ok, m.ok ? m.kind : null]),
          [
            ['mm.gguf', true, 'mmproj'],
            ['org/Big/Big-00001-of-00002.gguf', true, 'model'],
            ['small.gguf', true, 'model'],
          ],
        );
      }),
    );

    it.effect('a missing models folder lists no model', () =>
      Effect.gen(function* () {
        const { models } = yield* workspace;
        const reply = yield* send('GET', '/api/models');
        assert.strictEqual(reply.status, 200);
        const list = yield* as(ModelList, reply.json);
        assert.deepStrictEqual([list.dir, list.models], [models, []]);
      }),
    );

    it.effect('deleting a split model removes every part and the folders left empty, not the models folder', () =>
      Effect.gen(function* () {
        const { fs, models, at, seed } = yield* workspace;
        const { big, small } = yield* seed;
        const reply = yield* remove(big[0] ?? '', false);
        assert.deepStrictEqual([reply.status, reply.json], [200, { deletedFiles: big, deletedProfiles: [] }]);
        assert.deepStrictEqual(
          [yield* fs.exists(big[0] ?? ''), yield* fs.exists(big[1] ?? ''), yield* fs.exists(at('org'))],
          [false, false, false],
        );
        assert.deepStrictEqual([yield* fs.exists(small), yield* fs.exists(models)], [true, true]);
      }),
    );

    it.effect('deleting a symlinked model removes the link only', () =>
      Effect.gen(function* () {
        const { fs, home, at, writeAt } = yield* workspace;
        const target = yield* writeAt(`${home}/elsewhere/real.gguf`);
        yield* fs.makeDirectory(at('links'), { recursive: true });
        yield* fs.symlink(target, at('links/linked.gguf'));
        const reply = yield* remove(at('links/linked.gguf'), false);
        assert.deepStrictEqual(
          [reply.status, reply.json],
          [200, { deletedFiles: [at('links/linked.gguf')], deletedProfiles: [] }],
        );
        assert.deepStrictEqual([yield* fs.exists(at('links')), yield* fs.exists(target)], [false, true]);
      }),
    );

    it.effect('only a model the scan found can be deleted: another path is a 404', () =>
      Effect.gen(function* () {
        const { fs, home, seed, writeText } = yield* workspace;
        const { big } = yield* seed;
        const outside = yield* writeText(`${home}/outside.gguf`, 'x');
        const elsewhere = yield* remove(outside, false);
        // A later part is not an entry.
        const later = yield* remove(big[1] ?? '', false);
        const system = yield* usageOf('/etc/passwd');
        assert.deepStrictEqual([elsewhere, later, system], Arr.replicate({ status: 404, json: notFound }, 3));
        assert.deepStrictEqual([yield* fs.exists(outside), yield* fs.exists(big[1] ?? '')], [true, true]);
      }),
    );

    it.effect('usage of a later shard is a 404 Model not found', () =>
      Effect.gen(function* () {
        const { seed } = yield* workspace;
        const { big } = yield* seed;
        const reply = yield* usageOf(big[1] ?? '');
        assert.deepStrictEqual(reply, { status: 404, json: notFound });
      }),
    );

    it.effect('usage without a path or with an empty one is a 400 RequestInvalid path required', () =>
      Effect.gen(function* () {
        for (const path of ['/api/models/usage', '/api/models/usage?path=']) {
          const reply = yield* send('GET', path);
          assert.strictEqual(reply.status, 400, path);
          assert.deepStrictEqual(
            reply.json,
            {
              _tag: 'RequestInvalid',
              message: 'Invalid data: path required (path)',
              issues: [{ path: ['path'], message: 'path required' }],
            },
            path,
          );
        }
      }),
    );

    it.effect(
      'usage lists the profiles opening the file as model or projector, through a relative path or a symlink',
      () =>
        Effect.gen(function* () {
          const { fs, home, models, at, seed } = yield* workspace;
          yield* seed;
          const repo = yield* ProfilesRepo;
          yield* fs.symlink(models, `${home}/link`);
          const a = yield* repo.create(profile('A', { cwd: models, model: 'small.gguf' }));
          const b = yield* repo.create(profile('B', { model: `${home}/link/small.gguf` }));
          const c = yield* repo.create(profile('C', { cwd: '~/models', model: 'mm.gguf', mmproj: 'small.gguf' }));
          yield* repo.create(profile('D', { cwd: models, model: 'mm.gguf' }));
          const reply = yield* usageOf(at('small.gguf'));
          assert.strictEqual(reply.status, 200);
          const usage = reply.json as ModelUsage;
          // The bytes of the file on disk (`writeGguf` writes a header, its metadata and its tensors).
          const { size } = yield* fs.stat(at('small.gguf'));
          assert.isAbove(Number(size), 0);
          assert.deepStrictEqual(usage, {
            path: at('small.gguf'),
            files: [at('small.gguf')],
            fileBytes: Number(size),
            profiles: [
              { id: a.id, name: 'A', role: 'model' },
              { id: b.id, name: 'B', role: 'model' },
              { id: c.id, name: 'C', role: 'mmproj' },
            ],
            blocked: null,
          });
        }),
    );

    it.effect('deleteProfiles deletes the profiles using the model and resets the default; false keeps them', () =>
      Effect.gen(function* () {
        const { models, at, seed } = yield* workspace;
        yield* seed;
        const repo = yield* ProfilesRepo;
        const settings = yield* SettingsRepo;
        const a = yield* repo.create(profile('A', { cwd: models, model: 'small.gguf' }));
        const b = yield* repo.create(profile('B', { cwd: models, model: 'mm.gguf' }));
        yield* settings.patch({ defaultProfileId: a.id });
        const first = yield* remove(at('small.gguf'), true);
        assert.deepStrictEqual(
          [first.status, first.json],
          [200, { deletedFiles: [at('small.gguf')], deletedProfiles: [a.id] }],
        );
        const afterFirst = yield* profileIds;
        assert.deepStrictEqual(afterFirst, [b.id]);
        assert.isNull((yield* settings.get).defaultProfileId);

        const second = yield* remove(at('mm.gguf'), false);
        assert.deepStrictEqual(
          [second.status, second.json],
          [200, { deletedFiles: [at('mm.gguf')], deletedProfiles: [] }],
        );
        const afterSecond = yield* profileIds;
        assert.deepStrictEqual(afterSecond, [b.id]);
      }),
    );

    it.effect('a file that cannot be removed answers 500 and keeps the profiles', () =>
      Effect.gen(function* () {
        const { fs, models, write } = yield* workspace;
        const parts = [yield* write('Stuck-00001-of-00002.gguf'), yield* write(STUCK)];
        const repo = yield* ProfilesRepo;
        const a = yield* repo.create(profile('A', { cwd: models, model: 'Stuck-00001-of-00002.gguf' }));
        const reply = yield* remove(parts[0] ?? '', true);
        assert.strictEqual(reply.status, 500);
        assert.deepStrictEqual([yield* fs.exists(parts[0] ?? ''), yield* fs.exists(parts[1] ?? '')], [false, true]);
        const profilesKept = yield* profileIds;
        assert.deepStrictEqual(profilesKept, [a.id]);
      }),
    );

    it.effect('a model the running server uses or a download writes is a 409, and nothing is deleted', () =>
      Effect.gen(function* () {
        const { fs, models, at, seed } = yield* workspace;
        const { small, mm } = yield* seed;
        const repo = yield* ProfilesRepo;
        const settings = yield* SettingsRepo;
        const supervisor = yield* Supervisor;
        const writes = yield* Writes;
        yield* settings.patch({ binary: FAKE });
        const port = yield* freePort;
        const a = yield* repo.create(profile('A', { cwd: models, model: 'mm.gguf', mmproj: 'small.gguf', port }));

        const started = yield* send('POST', '/api/server/start', `{"profileId":${a.id}}`);
        assert.strictEqual(started.status, 202);
        const ready = yield* stateWhen(supervisor, 'ready');
        const running = 'The running server uses it (profile “A”): stop it first';
        assert.strictEqual(((yield* usageOf(small)).json as ModelUsage).blocked, running);
        const refused = yield* remove(small, true);
        assert.deepStrictEqual(refused, {
          status: 409,
          json: { _tag: 'ModelInUse', message: running },
        });
        const kept = yield* fs.exists(small);
        assert.isTrue(kept);
        const profilesLeft = yield* profileIds;
        assert.deepStrictEqual(profilesLeft, [a.id]);
        assert.strictEqual((yield* send('POST', '/api/server/stop')).status, 200);
        assert.isFalse(ready.kind === 'ready' && pidAlive(ready.pid));

        // A download in progress writes `small.gguf` (its path relative to the item's folder).
        yield* Ref.set(writes, [downloading(models, ['other.gguf', 'small.gguf'])]);
        const writing = 'A download in progress writes it';
        assert.strictEqual(((yield* usageOf(small)).json as ModelUsage).blocked, writing);
        const written = yield* remove(small, false);
        assert.deepStrictEqual(written, {
          status: 409,
          json: { _tag: 'ModelInUse', message: writing },
        });
        const still = yield* fs.exists(small);
        assert.isTrue(still);
        // Another model of the folder is not written.
        assert.isNull(((yield* usageOf(mm)).json as ModelUsage).blocked);

        yield* Ref.set(writes, []);
        assert.strictEqual((yield* remove(at('small.gguf'), false)).status, 200);
      }),
    );

    it.effect('info answers the detail of a model and of a file outside the models folder, its relPath absolute', () =>
      Effect.gen(function* () {
        const { home, write, writeAt } = yield* workspace;
        const inside = yield* write('sub/tiny.gguf');
        const outside = yield* writeAt(`${home}/elsewhere/tiny.gguf`);
        for (const [path, relPath] of [
          [inside, 'sub/tiny.gguf'],
          [outside, outside],
        ] as const) {
          const reply = yield* infoOf(path);
          assert.strictEqual(reply.status, 200, path);
          const detail = yield* as(ModelDetail, reply.json);
          assert.deepStrictEqual(
            {
              path: detail.path,
              relPath: detail.relPath,
              files: detail.files,
              kind: detail.kind,
              arch: detail.arch,
              name: detail.name,
              blockCount: detail.blockCount,
              tensorCount: detail.tensorCount,
              weights: detail.weights,
            },
            {
              path,
              relPath,
              files: [path],
              kind: 'model',
              arch: 'llama',
              name: 'Tiny',
              blockCount: 2,
              tensorCount: 7,
              weights: {
                embedBytes: 6400,
                outputBytes: 6400,
                layersBytes: 24576,
                expertsBytes: 0,
                otherBytes: 64,
                totalBytes: 37440,
              },
            },
          );
        }
      }),
    );

    it.effect('info refuses a relative path or another extension with a 400 RequestInvalid', () =>
      Effect.gen(function* () {
        const expected = 'Absolute path to a .gguf file expected';
        for (const query of ['', '?path=rel.gguf', '?path=%2Ftmp%2Fmodel.bin']) {
          const reply = yield* send('GET', `/api/models/info${query}`);
          assert.deepStrictEqual(
            reply,
            {
              status: 400,
              json: {
                _tag: 'RequestInvalid',
                message: `Invalid data: ${expected} (path)`,
                issues: [{ path: ['path'], message: expected }],
              },
            },
            query,
          );
        }
      }),
    );

    it.effect('info of a missing file or a folder is a 404 File not found', () =>
      Effect.gen(function* () {
        const { fs, at } = yield* workspace;
        yield* fs.makeDirectory(at('folder.gguf'), { recursive: true });
        const missing = yield* infoOf(at('missing.gguf'));
        const folder = yield* infoOf(at('folder.gguf'));
        assert.deepStrictEqual([missing, folder], Arr.replicate({ status: 404, json: fileNotFound }, 2));
      }),
    );

    it.effect('info of a file that is not a GGUF is a 422 with the read error', () =>
      Effect.gen(function* () {
        const { at, writeText } = yield* workspace;
        const path = yield* writeText(at('text.gguf'), 'not a gguf');
        const reply = yield* infoOf(path);
        assert.strictEqual(reply.status, 422);
        const error = reply.json as { _tag: string; message: string };
        assert.strictEqual(error._tag, 'ModelUnreadable');
        assert.isTrue(Str.startsWith('unreadable GGUF: ')(error.message), error.message);
      }),
    );
  });
});
