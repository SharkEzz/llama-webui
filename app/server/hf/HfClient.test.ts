import { NodeFileSystem } from '@effect/platform-node';
import { assert, layer } from '@effect/vitest';
import { HfRateLimited, type HfStatus, HfUnreachable, type HubErrors } from '@llama-webui/shared';
import { Array as Arr, ConfigProvider, Context, Effect, Fiber, FileSystem, Layer, String as Str } from 'effect';
import { TestClock } from 'effect/testing';
import { type FakeHub, fakeHub } from '../testing/hub.ts';
import { freePort } from '../testing/llama.ts';
import { HfClient } from './HfClient.ts';
import { HfHttp } from './HfHttp.ts';

const SHA = Str.repeat(40)('a');
/** A home and a token file that do not exist: no token but the one a test sets. */
const NOWHERE = '/nonexistent/lw-hf-client';

/** The client on `endpoint`, built on `env` as the whole environment: the token `hf_secret` unless `env` says else. */
const clientAt = (endpoint: string, env: Record<string, string> = {}) =>
  Layer.build(HfClient.layer.pipe(Layer.provide(HfHttp.layer))).pipe(
    Effect.map(Context.get(HfClient)),
    Effect.provideService(
      ConfigProvider.ConfigProvider,
      ConfigProvider.fromEnv({
        env: {
          HOME: NOWHERE,
          HF_TOKEN_PATH: `${NOWHERE}/token`,
          HF_ENDPOINT: endpoint,
          HF_TOKEN: 'hf_secret',
          ...env,
        },
      }),
    ),
  );
const clientOn = (hub: FakeHub, env: Record<string, string> = {}) => clientAt(hub.url, env);

/** The fake Hub with the one repository `o/r`. */
const hubWithRepo = fakeHub({
  repos: [{ id: 'o/r', sha: SHA, files: { 'm.gguf': 'gguf' } }],
  tokens: { hf_secret: 'alice' },
});

type HubError = InstanceType<(typeof HubErrors)[number]>;
/** The tag and the message of an error. */
const told = (error: HubError) => [error._tag, error.message] as const;

const login = ' (set HF_TOKEN or run `hf auth login`)';

/** Runs `effect` and checks what it succeeds with. */
const equals = <A, E, R>(effect: Effect.Effect<A, E, R>, expected: A) =>
  Effect.map(effect, (actual) => assert.deepStrictEqual(actual, expected));

/** Runs `effect` and checks what it fails with. */
const failsWith = <A, E, R>(effect: Effect.Effect<A, E, R>, expected: E) => equals(Effect.flip(effect), expected);

layer(NodeFileSystem.layer, { excludeTestServices: true })('HfClient', (it) => {
  it.effect('repo files: sizes and sha256 from the blobs listing, pinned commit', () =>
    Effect.gen(function* () {
      const hub = yield* fakeHub({
        repos: [
          {
            id: 'o/r',
            sha: SHA,
            gated: 'manual',
            files: { 'README.md': Str.repeat(12)('r'), 'm.gguf': { body: Str.repeat(99)('g'), sha256: 'abc' } },
          },
        ],
      });
      const client = yield* clientOn(hub);
      yield* equals(client.repoFiles('o/r', 'main'), {
        id: 'o/r',
        sha: SHA,
        gated: true,
        files: [
          { path: 'README.md', size: 12, sha256: null },
          { path: 'm.gguf', size: 99, sha256: 'abc' },
        ],
      });
      assert.deepStrictEqual(
        Arr.map(hub.requests(), (r) => [r.url, r.headers.authorization, r.headers['user-agent']]),
        [['/api/models/o/r/revision/main?blobs=true', 'Bearer hf_secret', 'llama-webui']],
      );
      // At the commit: the revision is a path segment of its own.
      const pinned = yield* client.repoFiles('o/r', SHA);
      assert.strictEqual(pinned.sha, SHA);
      assert.strictEqual(hub.requests()[1]?.url, `/api/models/o/r/revision/${SHA}?blobs=true`);
    }),
  );

  it.effect('search: GGUF filter, most downloaded first', () =>
    Effect.gen(function* () {
      const hub = yield* fakeHub({
        repos: [
          {
            id: 'a/Qwen-GGUF',
            downloads: 5,
            likes: 2,
            lastModified: '2026-01-01T00:00:00.000Z',
            files: { 'q.gguf': 'q' },
          },
          { id: 'b/Qwen-big-GGUF', downloads: 50, gated: 'auto', files: { 'q.gguf': 'q' } },
          { id: 'c/Qwen', downloads: 500, files: { 'model.safetensors': 's' } },
          { id: 'd/Llama-GGUF', downloads: 900, files: { 'l.gguf': 'l' } },
        ],
      });
      const client = yield* clientOn(hub);
      yield* equals(client.search('qwen'), [
        { id: 'b/Qwen-big-GGUF', downloads: 50, likes: 0, gated: true, lastModified: '2026-01-01T00:00:00.000Z' },
        { id: 'a/Qwen-GGUF', downloads: 5, likes: 2, gated: false, lastModified: '2026-01-01T00:00:00.000Z' },
      ]);
      yield* client.search('qwen 3');
      const url = new URL(hub.requests()[1]?.url ?? '', hub.url);
      assert.strictEqual(url.pathname, '/api/models');
      assert.strictEqual(url.searchParams.get('search'), 'qwen 3');
      assert.strictEqual(url.searchParams.get('filter'), 'gguf');
      assert.strictEqual(url.searchParams.get('sort'), 'downloads');
      assert.strictEqual(url.searchParams.get('direction'), '-1');
      assert.strictEqual(url.searchParams.get('limit'), '30');
      assert.deepStrictEqual(url.searchParams.getAll('expand[]'), ['downloads', 'likes', 'gated', 'lastModified']);
      // A row without its counts, its date or its gate: zero, null, not gated.
      hub.fail('search', { status: 200, headers: { 'content-type': 'application/json' }, body: '[{"id":"o/r"}]' });
      yield* equals(client.search('o'), [{ id: 'o/r', downloads: 0, likes: 0, gated: false, lastModified: null }]);
    }),
  );

  it.effect('errors carry a code', () =>
    Effect.gen(function* () {
      const hub = yield* hubWithRepo;
      const client = yield* clientOn(hub);
      const anonymous = yield* clientOn(hub, { HF_TOKEN: '' });
      const failing = (status: number, headers: Record<string, string> = {}, as = client) => {
        hub.fail('repo', { status, headers });
        return Effect.map(Effect.flip(as.repoFiles('o/r', 'main')), told);
      };
      // `x-error-code` first (a private or missing repository answers 401 RepoNotFound without a token).
      yield* equals(failing(401, { 'x-error-code': 'GatedRepo' }), [
        'HfGated',
        'o/r is gated: accept its license on Hugging Face',
      ]);
      yield* equals(failing(401, { 'x-error-code': 'RepoNotFound' }), [
        'HfNotFound',
        'o/r not found on Hugging Face (or private)',
      ]);
      yield* equals(failing(400, { 'x-error-code': 'RevisionNotFound' }), [
        'HfNotFound',
        'o/r not found on Hugging Face (or private)',
      ]);
      yield* equals(failing(400, { 'x-error-code': 'EntryNotFound' }), [
        'HfNotFound',
        'o/r not found on Hugging Face (or private)',
      ]);
      // Then the status.
      yield* equals(failing(403), ['HfGated', 'o/r is gated: accept its license on Hugging Face']);
      yield* equals(failing(404), ['HfNotFound', 'o/r not found on Hugging Face (or private)']);
      yield* equals(failing(401), ['HfUnauthorized', 'Hugging Face rejected the token']);
      yield* equals(failing(429), ['HfRateLimited', 'Hugging Face rate limit reached, try again later']);
      yield* equals(failing(503), ['HfUnreachable', 'Hugging Face error 503']);
      // Without a token, where to set one.
      yield* equals(failing(403, {}, anonymous), [
        'HfGated',
        `o/r is gated: accept its license on Hugging Face${login}`,
      ]);
      yield* equals(failing(404, {}, anonymous), ['HfNotFound', `o/r not found on Hugging Face (or private${login})`]);
      // A search names no repository.
      hub.fail('search', { status: 404 });
      yield* equals(Effect.map(Effect.flip(client.search('o')), told), [
        'HfNotFound',
        'Hugging Face resource not found on Hugging Face (or private)',
      ]);
      // Nothing listens: unreachable, with the reason.
      const port = yield* freePort;
      const nobody = yield* clientAt(`http://127.0.0.1:${port}`);
      const [tag, message] = yield* Effect.map(Effect.flip(nobody.repoFiles('o/r', 'main')), told);
      assert.strictEqual(tag, 'HfUnreachable');
      assert.match(message, /^Hugging Face unreachable: .*ECONNREFUSED/);
      // The errors of the API, as their classes build them.
      hub.fail('repo', { status: 429 });
      yield* failsWith(
        client.repoFiles('o/r', 'main'),
        HfRateLimited.make({ message: 'Hugging Face rate limit reached, try again later' }),
      );
    }),
  );

  it.effect('a 502 carries the x-error-message', () =>
    Effect.gen(function* () {
      const hub = yield* hubWithRepo;
      const client = yield* clientOn(hub);
      hub.fail('repo', { status: 502, headers: { 'x-error-message': 'upstream timed out' } });
      const error = yield* Effect.flip(client.repoFiles('o/r', 'main'));
      assert.deepStrictEqual(error, HfUnreachable.make({ message: 'Hugging Face error 502: upstream timed out' }));
    }),
  );

  it.effect('a 200 that is not the expected JSON is Hugging Face sent an invalid response', () =>
    Effect.gen(function* () {
      const hub = yield* hubWithRepo;
      const client = yield* clientOn(hub);
      // A proxy or a captive portal answering 200 with a page: the Hub is the problem, not the client.
      hub.fail('repo', { status: 200, headers: { 'content-type': 'text/html' }, body: '<html>' });
      yield* failsWith(
        client.repoFiles('o/r', 'main'),
        HfUnreachable.make({ message: 'Hugging Face sent an invalid response (/api/models/o/r/revision/main)' }),
      );
      hub.fail('repo', { status: 200, headers: { 'content-type': 'application/json' }, body: '{"id":1}' });
      yield* failsWith(
        client.repoFiles('o/r', 'main'),
        HfUnreachable.make({ message: 'Hugging Face sent an invalid response (/api/models/o/r/revision/main)' }),
      );
      hub.fail('search', { status: 200, headers: { 'content-type': 'application/json' }, body: '{"error":"no"}' });
      yield* failsWith(
        client.search('o'),
        HfUnreachable.make({ message: 'Hugging Face sent an invalid response (/api/models)' }),
      );
    }),
  );

  it.effect('a Hub call is aborted when its scope closes', () =>
    Effect.gen(function* () {
      const hub = yield* hubWithRepo;
      const client = yield* clientOn(hub);
      hub.fail('repo', { silence: true });
      const call = yield* Effect.forkChild(client.repoFiles('o/r', 'main'));
      yield* hub.requested(1, 'repo');
      yield* Fiber.interrupt(call);
      yield* hub.abandoned(1);
      assert.strictEqual(hub.aborted(), 1);
    }),
  );

  it.effect('status: token source and account, a rejected token is reported', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const hub = yield* hubWithRepo;
      const whoami = () => Arr.filter(hub.requests(), (r) => r.route === 'whoami');

      const ok = yield* clientOn(hub);
      const alice: HfStatus = { token: 'env', user: 'alice', tokenInvalid: false, endpoint: hub.url };
      yield* equals(ok.status, alice);
      yield* equals(ok.status, alice);
      // Cached per token.
      assert.deepStrictEqual(
        Arr.map(whoami(), (r) => [r.url, r.headers.authorization]),
        [['/api/whoami-v2', 'Bearer hf_secret']],
      );

      const bad = yield* clientOn(hub, { HF_TOKEN: 'hf_bad' });
      const rejected: HfStatus = { token: 'env', user: null, tokenInvalid: true, endpoint: hub.url };
      yield* equals(bad.status, rejected);
      yield* equals(bad.status, rejected);
      assert.strictEqual(whoami().length, 2);

      // The token of `hf auth login`.
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: 'lw-hf-client-' });
      yield* fs.writeFileString(`${dir}/token`, ' hf_secret \n');
      const fromFile = yield* clientOn(hub, { HF_TOKEN: '', HF_TOKEN_PATH: `${dir}/token` });
      yield* equals(fromFile.status, { ...alice, token: 'file' });

      const none = yield* clientOn(hub, { HF_TOKEN: '' });
      yield* equals(none.status, { token: null, user: null, tokenInvalid: false, endpoint: hub.url });
      assert.strictEqual(whoami().length, 3);
    }),
  );

  it.effect('a whoami that fails on the network is not cached', () =>
    Effect.gen(function* () {
      const hub = yield* hubWithRepo;
      const client = yield* clientOn(hub);
      const unchecked: HfStatus = { token: 'env', user: null, tokenInvalid: false, endpoint: hub.url };
      // The answer cut in its body, then a Hub that fails: no account, the token not taken as rejected.
      hub.fail('whoami', { cut: 2 });
      yield* equals(client.status, unchecked);
      hub.fail('whoami', { status: 503 });
      yield* equals(client.status, unchecked);
      // Asked again, and answered.
      yield* equals(client.status, { ...unchecked, user: 'alice' });
      assert.strictEqual(Arr.filter(hub.requests(), (r) => r.route === 'whoami').length, 3);
    }),
  );
});

// On the TestClock: the fake Hub answers in real time, the client's timeout runs on the test's clock.
layer(NodeFileSystem.layer)('HfClient timeout', (it) => {
  it.effect('a Hub call without an answer in 10 s is HfUnreachable', () =>
    Effect.gen(function* () {
      const hub = yield* hubWithRepo;
      const client = yield* clientOn(hub);
      hub.fail('repo', { silence: true });
      const call = yield* Effect.forkChild(client.repoFiles('o/r', 'main'));
      yield* hub.requested(1, 'repo');
      yield* TestClock.adjust('9 seconds');
      assert.isUndefined(call.pollUnsafe());
      yield* TestClock.adjust('1 second');
      yield* failsWith(
        Fiber.join(call),
        HfUnreachable.make({ message: 'Hugging Face unreachable: no answer in 10 s' }),
      );
      // The request is dropped with it.
      yield* hub.abandoned(1);
    }),
  );
});
