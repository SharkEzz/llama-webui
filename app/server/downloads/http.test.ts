import * as NodeServices from '@effect/platform-node/NodeServices';
import { assert, layer } from '@effect/vitest';
import { DownloadItem, DownloadList } from '@llama-webui/shared';
import {
  Array as Arr,
  ConfigProvider,
  Context,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Schedule,
  Schema,
  String as Str,
} from 'effect';
import { HttpClient, HttpClientRequest, HttpServer } from 'effect/http';
import { partPath, sizeOf } from '../hf/paths.ts';
import { ApiRoutes, serve } from '../http/HttpLive.ts';
import { ServerTest } from '../testing/http.ts';
import { type FakeHub, fakeHub } from '../testing/hub.ts';
import { ServicesTest } from '../testing/services.ts';
import { ofType, openWs, type WsClient } from '../testing/ws.ts';
import { WsHub } from '../ws/WsHub.ts';

/** The home of the test (`HOME`): the models folder is the default `~/models` under it. */
class Home extends Context.Service<Home, string>()('@llama-webui/app/server/downloads/http.test/Home') {}

/** The fake Hub of the test. */
class Hub extends Context.Service<Hub, FakeHub>()('@llama-webui/app/server/downloads/http.test/Hub') {}

/** `org/repo`: two models and a projector. */
const FILES = {
  'README.md': '# org/repo',
  'Model-Q4_K_M.gguf': Str.repeat(30)('q'),
  'Model-Q2_K.gguf': Str.repeat(20)('k'),
  'mmproj-F16.gguf': Str.repeat(5)('m'),
};

/**
 * `HOME` a temporary folder of the test's own, the Hub the fake one, no token (neither variable nor file), and `extra`;
 * the rest of the configuration as it is.
 */
const hubConfig = (extra: Readonly<Record<string, string>>) =>
  ConfigProvider.layerAdd(
    Effect.gen(function* () {
      const home = yield* Home;
      const hub = yield* Hub;
      return ConfigProvider.fromUnknown({
        HOME: home,
        HF_ENDPOINT: hub.url,
        HF_TOKEN: '',
        HUGGING_FACE_HUB_TOKEN: '',
        HF_TOKEN_PATH: `${home}/no-token`,
        ...extra,
      });
    }),
    { asPrimary: true },
  ).pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        Layer.effect(
          Home,
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            return yield* fs.makeTempDirectoryScoped({ prefix: 'lw-downloads-http-' });
          }),
        ),
        Layer.effect(Hub, fakeHub({ repos: [{ id: 'org/repo', files: FILES }] })),
      ),
    ),
  );

/**
 * The API and `/ws` as the app serves them, on a real server and the services of the app (the queue among them), a
 * home of its own and the fake Hub.
 */
const served = (extra: Readonly<Record<string, string>> = {}) =>
  serve(Layer.merge(ApiRoutes, WsHub.route)).pipe(
    Layer.provideMerge(ServicesTest),
    Layer.provideMerge(ServerTest),
    Layer.provideMerge(hubConfig(extra)),
    Layer.provideMerge(NodeServices.layer),
  );

const parseJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const toJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

/** The status and (when it is JSON) the value of a raw request; `body` is sent as JSON. */
const send = Effect.fnUntraced(function* (method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown) {
  const client = yield* HttpClient.HttpClient;
  const base = HttpClientRequest.make(method)(path);
  const text = body === undefined ? undefined : yield* toJson(body);
  const request = text === undefined ? base : HttpClientRequest.bodyText(base, text, 'application/json');
  const res = yield* client.execute(request);
  const answer = yield* res.text;
  const isJson = Option.exists(Option.fromNullishOr(res.headers['content-type']), Str.startsWith('application/json'));
  const json: unknown = isJson && Str.isNonEmpty(answer) ? yield* parseJson(answer) : undefined;
  return { status: res.status, json };
});

/** A JSON reply as the schema reads it: a reply of another shape fails the test. */
const as = <A, I>(schema: Schema.Codec<A, I>, json: unknown) => Schema.decodeUnknownEffect(schema)(json);

const Created = Schema.Struct({ items: Schema.Array(DownloadItem) });

/** The body of a 400 `RequestInvalid`. */
const Refused = Schema.TaggedStruct('RequestInvalid', {
  message: Schema.String,
  issues: Schema.Array(Schema.Struct({ path: Schema.Array(Schema.String), message: Schema.String })),
});

/** Runs `effect` and checks what it succeeds with (`message` names the case). */
const equals = <A, E, R>(effect: Effect.Effect<A, E, R>, expected: A, message?: string) =>
  Effect.map(effect, (actual) => assert.deepStrictEqual(actual, expected, message));

/** A request for `keys` of `org/repo` at its commit. */
const request = (keys: ReadonlyArray<string>) =>
  Effect.map(Hub, (hub) => ({ repo: 'org/repo', revision: hub.shaOf('org/repo'), keys }));

/** Posts a request for `keys` of `org/repo`: the reply as it is. */
const post = (keys: ReadonlyArray<string>) =>
  Effect.flatMap(request(keys), (body) => send('POST', '/api/downloads', body));

/** Posts a download of `keys` of `org/repo`: the items queued. */
const download = Effect.fnUntraced(function* (keys: ReadonlyArray<string>) {
  const reply = yield* post(keys);
  assert.strictEqual(reply.status, 202);
  return (yield* as(Created, reply.json)).items;
});

/** The queue as `GET /api/downloads` answers it. */
const list = Effect.gen(function* () {
  const reply = yield* send('GET', '/api/downloads');
  assert.strictEqual(reply.status, 200);
  return yield* as(DownloadList, reply.json);
});

/** The status of the item `id` once it is `status` (5 s at most). */
const settled = (id: number, status: DownloadItem['status']) =>
  list.pipe(
    Effect.map((queue) => Arr.findFirst(queue.items, (item) => item.id === id)),
    Effect.repeat({
      until: (item) => Option.exists(item, (it) => it.status === status),
      schedule: Schedule.spaced('20 millis'),
    }),
    Effect.timeout('5 seconds'),
    Effect.map(Option.getOrThrow),
  );

/** The file `rel` of `org/repo` under the test's models folder. */
const inRepo = Effect.fnUntraced(function* (rel: string) {
  const home = yield* Home;
  const path = yield* Path.Path;
  return path.join(home, 'models', 'org', 'repo', rel);
});

/** A `/ws` client of the test's server, closed with the test's scope. */
const wsClient = Effect.gen(function* () {
  const server = yield* HttpServer.HttpServer;
  const url = `${Str.replace('http', 'ws')(HttpServer.formatAddress(server.address))}/ws`;
  return yield* Effect.acquireRelease(
    Effect.promise(() => openWs(url)),
    (client) => Effect.sync(() => client.socket.close()),
  );
});

/** The next message of `type` that `match` accepts. */
const next = (client: WsClient, type: string, match: (payload: unknown) => boolean = () => true) =>
  Effect.promise(() =>
    client.next((message) => ofType(type)(message) && match((message as { readonly payload: unknown }).payload), 5000),
  );

const statusIs = (status: string) => (payload: unknown) =>
  typeof payload === 'object' && payload !== null && 'status' in payload && payload.status === status;

layer(served(), { excludeTestServices: true, buildPerTest: true })('over HTTP', (it) => {
  it.effect(
    'a valid download request stores the canonical repo id and the resolved sha and answers 202 with the items',
    () =>
      Effect.gen(function* () {
        const hub = yield* Hub;
        const home = yield* Home;
        const fs = yield* FileSystem.FileSystem;
        // The repository was renamed: the Hub answers its new id and the commit of its default branch.
        hub.add({ id: 'org/renamed', files: FILES });
        hub.fail('repo', { status: 307, headers: { location: '/api/models/org/renamed/revision/main?blobs=true' } });
        const items = yield* download(['Model-Q4_K_M.gguf']);
        const sha = hub.shaOf('org/renamed');
        assert.notStrictEqual(sha, hub.shaOf('org/repo'));
        assert.deepStrictEqual(
          Arr.map(items, (item) => [
            item.repo,
            item.revision,
            item.key,
            item.kind,
            item.dir,
            item.status,
            item.totalBytes,
          ]),
          [['org/renamed', sha, 'Model-Q4_K_M.gguf', 'model', `${home}/models/org/renamed`, 'queued', 30]],
        );
        assert.deepStrictEqual(
          Arr.map(items[0]?.files ?? [], (file) => [file.path, file.size, file.done]),
          [['Model-Q4_K_M.gguf', 30, false]],
        );
        // Stored as answered, and downloaded from the new id at that commit.
        const id = items[0]?.id ?? 0;
        const done = yield* settled(id, 'done');
        assert.deepStrictEqual([done.repo, done.revision], ['org/renamed', sha]);
        const written = yield* fs.readFileString(`${home}/models/org/renamed/Model-Q4_K_M.gguf`);
        assert.strictEqual(written, FILES['Model-Q4_K_M.gguf']);
        assert.isTrue(
          Arr.some(
            hub.requests(),
            (r) => r.route === 'resolve' && r.url === `/org/renamed/resolve/${sha}/Model-Q4_K_M.gguf`,
          ),
        );
      }),
  );

  it.effect('a request naming a key the repo lacks is a 404 No GGUF', () =>
    Effect.gen(function* () {
      yield* equals(post(['Model-Q4_K_M.gguf', 'nope.gguf']), {
        status: 404,
        json: { _tag: 'HfNotFound', message: 'No GGUF “nope.gguf” in org/repo' },
      });
      assert.deepStrictEqual((yield* list).items, []);
    }),
  );

  it.effect('a key listed twice is a 400', () =>
    Effect.gen(function* () {
      yield* equals(post(['Model-Q4_K_M.gguf', 'Model-Q4_K_M.gguf']), {
        status: 400,
        json: { _tag: 'ListedTwice', message: 'Model-Q4_K_M is listed twice' },
      });
      assert.deepStrictEqual((yield* list).items, []);
    }),
  );

  it.effect('an invalid request is a 400 RequestInvalid', () =>
    Effect.gen(function* () {
      const hub = yield* Hub;
      const good = yield* request(['Model-Q4_K_M.gguf']);
      const cases: ReadonlyArray<readonly [unknown, string]> = [
        [{ ...good, repo: 'bad' }, 'Invalid data: Repository id expected (org/name) (repo)'],
        [{ ...good, revision: 'main' }, 'Invalid data: Commit sha expected (revision)'],
        [{ ...good, keys: Arr.makeBy(17, (i) => `k${i}.gguf`) }, 'Invalid data: 16 variants at most (keys)'],
        [{ ...good, force: true }, 'Invalid data: unknown key (force)'],
      ];
      for (const [body, message] of cases) {
        const reply = yield* send('POST', '/api/downloads', body);
        assert.strictEqual(reply.status, 400, message);
        assert.strictEqual((yield* as(Refused, reply.json)).message, message);
      }
      assert.deepStrictEqual(hub.requests(), []);
    }),
  );

  it.effect('delete of a running item cancels it and answers 204 at once', () =>
    Effect.gen(function* () {
      const hub = yield* Hub;
      const fs = yield* FileSystem.FileSystem;
      // The CDN sends the first 10 bytes, then nothing more.
      hub.fail('cdn', { stall: 10 });
      const [item] = yield* download(['Model-Q4_K_M.gguf']);
      const id = item?.id ?? 0;
      const dest = yield* inRepo('Model-Q4_K_M.gguf');
      const part = partPath(dest);
      yield* sizeOf(part).pipe(
        Effect.repeat({ until: Option.contains(10), schedule: Schedule.spaced('10 millis') }),
        Effect.timeout('5 seconds'),
      );
      const reply = yield* send('DELETE', `/api/downloads/${id}`).pipe(Effect.timeout('1 second'));
      assert.deepStrictEqual(reply, { status: 204, json: undefined });
      const canceled = yield* settled(id, 'canceled');
      assert.strictEqual(canceled.status, 'canceled');
      const left = yield* fs.exists(part);
      assert.isFalse(left);
      yield* hub.abandoned(1);
      assert.isNull((yield* list).live);
    }),
  );

  it.effect('delete of a finished item removes it and keeps its files', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const [item] = yield* download(['Model-Q4_K_M.gguf']);
      const id = item?.id ?? 0;
      yield* settled(id, 'done');
      yield* equals(send('DELETE', `/api/downloads/${id}`), { status: 204, json: undefined });
      assert.deepStrictEqual((yield* list).items, []);
      const dest = yield* inRepo('Model-Q4_K_M.gguf');
      const kept = yield* fs.readFileString(dest);
      assert.strictEqual(kept, FILES['Model-Q4_K_M.gguf']);
    }),
  );

  it.effect('delete of an unknown id is a 404 Download not found, of abc the unknown route', () =>
    Effect.gen(function* () {
      const notFound = { status: 404, json: { _tag: 'DownloadNotFound', message: 'Download not found' } };
      const unknown = { status: 404, json: { _tag: 'RouteNotFound', message: 'Unknown route' } };
      yield* equals(send('DELETE', '/api/downloads/999'), notFound);
      yield* equals(send('POST', '/api/downloads/999/retry'), notFound);
      yield* equals(send('DELETE', '/api/downloads/abc'), unknown);
      yield* equals(send('POST', '/api/downloads/abc/retry'), unknown);
    }),
  );

  it.effect('retry of a failed item answers 202 with it queued', () =>
    Effect.gen(function* () {
      const hub = yield* Hub;
      hub.fail('resolve', { status: 404 });
      const [item] = yield* download(['Model-Q4_K_M.gguf']);
      const id = item?.id ?? 0;
      const failed = yield* settled(id, 'error');
      assert.isNotNull(failed.error);
      const reply = yield* send('POST', `/api/downloads/${id}/retry`);
      assert.strictEqual(reply.status, 202);
      const queued = yield* as(DownloadItem, reply.json);
      assert.deepStrictEqual(
        [queued.id, queued.status, queued.error, queued.code, queued.finishedAt],
        [id, 'queued', null, null, null],
      );
      yield* settled(id, 'done');
      yield* equals(send('POST', `/api/downloads/${id}/retry`), {
        status: 409,
        json: { _tag: 'NotFinished', message: 'Only a failed or canceled download can be retried' },
      });
    }),
  );

  it.effect('clear answers the count', () =>
    Effect.gen(function* () {
      const hub = yield* Hub;
      yield* equals(send('POST', '/api/downloads/clear'), { status: 200, json: { deleted: 0 } });
      // The first item fails, the second ends done.
      hub.fail('resolve', { status: 404 });
      const items = yield* download(['Model-Q4_K_M.gguf', 'Model-Q2_K.gguf']);
      const [first, second] = Arr.map(items, (item) => item.id);
      yield* settled(first ?? 0, 'error');
      yield* settled(second ?? 0, 'done');
      yield* equals(send('POST', '/api/downloads/clear'), { status: 200, json: { deleted: 2 } });
      assert.deepStrictEqual((yield* list).items, []);
    }),
  );

  it.effect("the queue's messages reach a /ws client: download, download-progress and download-deleted", () =>
    Effect.gen(function* () {
      const client = yield* wsClient;
      yield* next(client, 'hello');
      const [item] = yield* download(['Model-Q4_K_M.gguf']);
      const id = item?.id ?? 0;
      const idIs = (payload: unknown) =>
        typeof payload === 'object' && payload !== null && 'id' in payload && payload.id === id;
      yield* next(client, 'download', (payload) => idIs(payload) && statusIs('queued')(payload));
      yield* next(client, 'download', (payload) => idIs(payload) && statusIs('downloading')(payload));
      yield* next(client, 'download-progress', idIs);
      yield* next(client, 'download', (payload) => idIs(payload) && statusIs('done')(payload));
      yield* next(client, 'download-progress', (payload) => payload === null);
      yield* equals(send('DELETE', `/api/downloads/${id}`), { status: 204, json: undefined });
      const deleted = yield* next(client, 'download-deleted');
      assert.deepStrictEqual(deleted, { type: 'download-deleted', payload: { ids: [id] } });
    }),
  );
});

layer(served({ LLAMA_WEBUI_TEST_OFFLINE: '1' }), { excludeTestServices: true })('offline', (it) => {
  it.effect('with LLAMA_WEBUI_TEST_OFFLINE=1 a download request is a 502 Hugging Face unreachable: fetch failed', () =>
    Effect.gen(function* () {
      const hub = yield* Hub;
      yield* equals(post(['Model-Q4_K_M.gguf']), {
        status: 502,
        json: { _tag: 'HfUnreachable', message: 'Hugging Face unreachable: fetch failed' },
      });
      assert.deepStrictEqual(hub.requests(), []);
      assert.deepStrictEqual((yield* list).items, []);
    }),
  );
});
