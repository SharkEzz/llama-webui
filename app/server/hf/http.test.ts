import { NodeServices } from '@effect/platform-node';
import { assert, layer } from '@effect/vitest';
import { HfRepo, HfSearchHit, HfStatus } from '@llama-webui/shared';
import {
  Array as Arr,
  ConfigProvider,
  Context,
  Effect,
  Fiber,
  FileSystem,
  Layer,
  Option,
  Path,
  Schema,
  String as Str,
} from 'effect';
import { HttpClient, HttpClientRequest } from 'effect/http';
import { ApiRoutes, serve } from '../http/HttpLive.ts';
import { ServerTest } from '../testing/http.ts';
import { type FakeHub, fakeHub } from '../testing/hub.ts';
import { ServicesTest } from '../testing/services.ts';

/** The home of the test (`HOME`): the models folder is the default `~/models` under it. */
class Home extends Context.Service<Home, string>()('@llama-webui/app/server/hf/http.test/Home') {}

/** The fake Hub of the test. */
class Hub extends Context.Service<Hub, FakeHub>()('@llama-webui/app/server/hf/http.test/Hub') {}

/** `org/repo`: three models (one split in two), two projectors and a README. */
const FILES = {
  'README.md': '# org/repo',
  'Model-Q4_K_M.gguf': Str.repeat(30)('q'),
  'Model-Q2_K.gguf': Str.repeat(20)('k'),
  'Q8_0/Model-Q8_0-00001-of-00002.gguf': Str.repeat(40)('1'),
  'Q8_0/Model-Q8_0-00002-of-00002.gguf': Str.repeat(40)('2'),
  'Model-BF16.gguf': Str.repeat(100)('b'),
  'mmproj-F16.gguf': Str.repeat(5)('m'),
  'mmproj-BF16.gguf': Str.repeat(6)('n'),
};

/**
 * `HOME` a temporary folder of the test's own, the Hub the fake one, no token (neither variable nor file); the rest of
 * the configuration as it is.
 */
const HubConfig = ConfigProvider.layerAdd(
  Effect.gen(function* () {
    const home = yield* Home;
    const hub = yield* Hub;
    return ConfigProvider.fromUnknown({
      HOME: home,
      HF_ENDPOINT: hub.url,
      // Blank, not empty: an empty value counts as unset, and the environment's token would be read.
      HF_TOKEN: ' ',
      HUGGING_FACE_HUB_TOKEN: ' ',
      HF_TOKEN_PATH: `${home}/no-token`,
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
          return yield* fs.makeTempDirectoryScoped({ prefix: 'lw-hf-' });
        }),
      ),
      Layer.effect(Hub, fakeHub({ repos: [{ id: 'org/repo', downloads: 7, files: FILES }] })),
    ),
  ),
);

/** The API as the app serves it, on a real server and the services of the app, a home of its own and the fake Hub. */
const Served = serve(ApiRoutes).pipe(
  Layer.provideMerge(ServicesTest),
  Layer.provideMerge(ServerTest),
  Layer.provideMerge(HubConfig),
  Layer.provideMerge(NodeServices.layer),
);

const parseJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

/** The status and (when it is JSON) the value of a raw GET. */
const get = Effect.fnUntraced(function* (path: string) {
  const client = yield* HttpClient.HttpClient;
  const res = yield* client.execute(HttpClientRequest.get(path));
  const text = yield* res.text;
  const isJson = Option.exists(Option.fromNullishOr(res.headers['content-type']), Str.startsWith('application/json'));
  const json: unknown = isJson && Str.isNonEmpty(text) ? yield* parseJson(text) : undefined;
  return { status: res.status, json };
});

/** A JSON reply as the schema reads it: a reply of another shape fails the test. */
const as = <A, I>(schema: Schema.Codec<A, I>, json: unknown) => Schema.decodeUnknownEffect(schema)(json);

/** Runs `effect` and checks what it succeeds with (`message` names the case). */
const equals = <A, E, R>(effect: Effect.Effect<A, E, R>, expected: A, message?: string) =>
  Effect.map(effect, (actual) => assert.deepStrictEqual(actual, expected, message));

/** Writes `text` at `rel` under the folder of `org/repo` (its folders made). */
const writeInRepo = Effect.fnUntraced(function* (rel: string, text: string) {
  const fs = yield* FileSystem.FileSystem;
  const paths = yield* Path.Path;
  const home = yield* Home;
  const file = paths.join(home, 'models', 'org', 'repo', rel);
  yield* fs.makeDirectory(paths.dirname(file), { recursive: true });
  yield* fs.writeFileString(file, text);
});

layer(Served, { excludeTestServices: true, buildPerTest: true })('over HTTP', (it) => {
  it.effect('repo answers the variants with their present state none, partial and complete, its url and dir', () =>
    Effect.gen(function* () {
      const hub = yield* Hub;
      const home = yield* Home;
      // Every file of Q4_K_M; one shard of two of Q8_0; BF16 at a wrong size; Q2_K only begun (`.part`).
      yield* writeInRepo('Model-Q4_K_M.gguf', FILES['Model-Q4_K_M.gguf']);
      yield* writeInRepo('Q8_0/Model-Q8_0-00001-of-00002.gguf', FILES['Q8_0/Model-Q8_0-00001-of-00002.gguf']);
      yield* writeInRepo('Model-BF16.gguf', 'short');
      yield* writeInRepo('Model-Q2_K.gguf.part', 'k');
      yield* writeInRepo('mmproj-BF16.gguf', FILES['mmproj-BF16.gguf']);
      const reply = yield* get('/api/hf/repo?id=org/repo');
      assert.strictEqual(reply.status, 200);
      const repo = yield* as(HfRepo, reply.json);
      assert.deepStrictEqual(
        [repo.id, repo.sha, repo.gated, repo.url, repo.dir],
        ['org/repo', hub.shaOf('org/repo'), false, `${hub.url}/org/repo`, `${home}/models/org/repo`],
      );
      assert.deepStrictEqual(
        Arr.map(repo.variants, (v) => [v.key, v.quant, v.totalBytes, v.present]),
        [
          ['Model-Q2_K.gguf', 'Q2_K', 20, 'partial'],
          ['Model-Q4_K_M.gguf', 'Q4_K_M', 30, 'complete'],
          ['Q8_0/Model-Q8_0-00001-of-00002.gguf', 'Q8_0', 80, 'partial'],
          ['Model-BF16.gguf', 'BF16', 100, 'partial'],
        ],
      );
      assert.deepStrictEqual(
        Arr.map(repo.projectors, (v) => [v.key, v.kind, v.present]),
        [
          ['mmproj-F16.gguf', 'mmproj', 'none'],
          ['mmproj-BF16.gguf', 'mmproj', 'complete'],
        ],
      );
      assert.deepStrictEqual(repo.variants[1]?.files, [
        { path: 'Model-Q4_K_M.gguf', size: 30, sha256: repo.variants[1]?.files[0]?.sha256 ?? '' },
      ]);
      assert.match(repo.variants[1]?.files[0]?.sha256 ?? '', /^[0-9a-f]{64}$/);
      // The default branch, then the commit it answered.
      const pinned = yield* get(`/api/hf/repo?id=org/repo&revision=${repo.sha}`);
      assert.strictEqual(pinned.status, 200);
      const empty = yield* get('/api/hf/repo?id=org/repo&revision=');
      assert.strictEqual(empty.status, 200);
      assert.deepStrictEqual(
        Arr.map(
          Arr.filter(hub.requests(), (r) => r.route === 'repo'),
          (r) => r.url,
        ),
        [
          '/api/models/org/repo/revision/main?blobs=true',
          `/api/models/org/repo/revision/${repo.sha}?blobs=true`,
          '/api/models/org/repo/revision/main?blobs=true',
        ],
      );
      // A repository the Hub does not know.
      yield* equals(get('/api/hf/repo?id=org/missing'), {
        status: 404,
        json: {
          _tag: 'HfNotFound',
          message: 'org/missing not found on Hugging Face (or private (set HF_TOKEN or run `hf auth login`))',
        },
      });
    }),
  );

  it.effect('repo with an invalid id is a 400 RequestInvalid', () =>
    Effect.gen(function* () {
      const hub = yield* Hub;
      for (const [query, id] of [
        ['?id=bad', 'bad'],
        ['?id=..%2Fx', '../x'],
        ['', ''],
      ] as const) {
        const message = `Invalid repository id: ${id}`;
        yield* equals(
          get(`/api/hf/repo${query}`),
          {
            status: 400,
            json: {
              _tag: 'RequestInvalid',
              message: `Invalid data: ${message} (id)`,
              issues: [{ path: ['id'], message }],
            },
          },
          query,
        );
      }
      assert.deepStrictEqual(hub.requests(), []);
    }),
  );

  it.effect('repo of a renamed repository answers the new id, its page and its folder', () =>
    Effect.gen(function* () {
      const hub = yield* Hub;
      const home = yield* Home;
      hub.add({ id: 'org/renamed', files: FILES });
      hub.fail('repo', { status: 307, headers: { location: '/api/models/org/renamed/revision/main?blobs=true' } });
      const reply = yield* get('/api/hf/repo?id=org/repo');
      assert.strictEqual(reply.status, 200);
      const repo = yield* as(HfRepo, reply.json);
      assert.deepStrictEqual(
        [repo.id, repo.sha, repo.url, repo.dir],
        ['org/renamed', hub.shaOf('org/renamed'), `${hub.url}/org/renamed`, `${home}/models/org/renamed`],
      );
    }),
  );

  it.effect('repo of a gated repository is a 403 HfGated', () =>
    Effect.gen(function* () {
      const hub = yield* Hub;
      hub.fail('repo', { status: 403, headers: { 'x-error-code': 'GatedRepo' } });
      yield* equals(get('/api/hf/repo?id=org/repo'), {
        status: 403,
        json: {
          _tag: 'HfGated',
          message: 'org/repo is gated: accept its license on Hugging Face (set HF_TOKEN or run `hf auth login`)',
        },
      });
    }),
  );

  it.effect('search refuses an empty or a 201-character text with a 400', () =>
    Effect.gen(function* () {
      const hub = yield* Hub;
      const message = 'Search text expected (200 characters at most)';
      for (const query of ['', '?q=', '?q=%20%20', `?q=${Str.repeat(201)('a')}`]) {
        yield* equals(
          get(`/api/hf/search${query}`),
          {
            status: 400,
            json: {
              _tag: 'RequestInvalid',
              message: `Invalid data: ${message} (q)`,
              issues: [{ path: ['q'], message }],
            },
          },
          query,
        );
      }
      assert.deepStrictEqual(hub.requests(), []);
      // 200 characters are a search; the text is trimmed.
      yield* equals(get(`/api/hf/search?q=${Str.repeat(200)('a')}`), { status: 200, json: [] });
      const reply = yield* get('/api/hf/search?q=%20repo%20');
      assert.strictEqual(reply.status, 200);
      const hits = yield* as(Schema.Array(HfSearchHit), reply.json);
      assert.deepStrictEqual(
        Arr.map(hits, (hit) => hit.id),
        ['org/repo'],
      );
      const last = new URL(hub.requests()[1]?.url ?? '', hub.url);
      assert.strictEqual(last.searchParams.get('search'), 'repo');
    }),
  );

  it.effect('a client that leaves aborts the Hub call', () =>
    Effect.gen(function* () {
      const hub = yield* Hub;
      hub.fail('search', { silence: true });
      const call = yield* Effect.forkChild(get('/api/hf/search?q=repo'));
      yield* hub.requested(1, 'search');
      yield* Fiber.interrupt(call);
      yield* hub.abandoned(1);
      assert.strictEqual(hub.aborted(), 1);
    }),
  );

  it.effect('status without a token asks nothing of the Hub', () =>
    Effect.gen(function* () {
      const hub = yield* Hub;
      const reply = yield* get('/api/hf/status');
      assert.strictEqual(reply.status, 200);
      yield* equals(as(HfStatus, reply.json), {
        token: null,
        user: null,
        tokenInvalid: false,
        endpoint: hub.url,
      });
      assert.deepStrictEqual(hub.requests(), []);
    }),
  );
});
