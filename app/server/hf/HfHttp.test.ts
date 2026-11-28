import { assert, describe, it } from '@effect/vitest';
import { ConfigProvider, Effect, Layer, String as Str, Stream } from 'effect';
import { HttpClientRequest } from 'effect/http';
import { httpStub, later, proxiedEnvironment, until } from '../testing/llama.ts';
import { connectStub } from '../testing/proxy.ts';
import { HfHttp } from './HfHttp.ts';

const decoder = new TextDecoder();

/** `effect` with an `HfHttp` of its own, built on `env` as the whole environment and ended with it. */
const withHfHttp =
  (env: Record<string, string>) =>
  <A, E, R>(effect: Effect.Effect<A, E, R | HfHttp>) =>
    Layer.build(HfHttp.layer).pipe(
      Effect.flatMap((context) => Effect.provideContext(effect, context)),
      Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnv({ env })),
      Effect.scoped,
    );

/** The text of a GET of `url`, or the tag of its failure's reason. */
const textOf = Effect.fnUntraced(function* (url: string) {
  const client = yield* HfHttp;
  return yield* client.get(url).pipe(
    Effect.flatMap((res) => res.text),
    Effect.scoped,
    Effect.catchTag('HttpClientError', (error) => Effect.succeed(error.reason._tag)),
  );
});

describe('HfHttp', () => {
  it.live('a redirect is the response, with its location, not followed', () =>
    Effect.gen(function* () {
      let followed = 0;
      const stub = yield* httpStub((req, res) => {
        if (req.url === '/cdn') followed++;
        res.writeHead(302, { location: '/cdn' }).end();
      });
      const client = yield* HfHttp;
      const reply = yield* client.get(`${stub.url}/resolve`).pipe(
        Effect.map((res) => [res.status, res.headers.location] as const),
        Effect.scoped,
      );
      assert.deepStrictEqual(reply, [302, '/cdn']);
      assert.strictEqual(followed, 0);
    }).pipe(withHfHttp({})),
  );

  it.live('sends the headers, streams the body, and leaving the scope during it aborts the request', () =>
    Effect.gen(function* () {
      const seen: Array<unknown> = [];
      let closed = false;
      const stub = yield* httpStub((req, res) => {
        seen.push([req.headers.range, req.headers['user-agent']]);
        res.on('close', () => {
          closed = !res.writableEnded;
        });
        res.writeHead(206, { 'content-range': 'bytes 3-9/10' }).write('one');
      });
      const client = yield* HfHttp;
      const reply = yield* client
        .execute(
          HttpClientRequest.get(stub.url).pipe(
            HttpClientRequest.setHeaders({ range: 'bytes=3-', 'user-agent': 'llama-webui' }),
          ),
        )
        .pipe(
          Effect.flatMap((res) =>
            res.stream.pipe(
              Stream.map((chunk) => decoder.decode(chunk)),
              Stream.take(1),
              Stream.runCollect,
              Effect.map((first) => [res.status, res.headers['content-range'], first] as const),
            ),
          ),
          Effect.scoped,
        );
      assert.deepStrictEqual(seen, [['bytes=3-', 'llama-webui']]);
      assert.deepStrictEqual(reply, [206, 'bytes 3-9/10', ['one']]);
      // The body never ended: the scope's end aborted the request.
      yield* until(() => closed);
    }).pipe(withHfHttp({})),
  );

  it.live('an https URL goes through node:https (TLS against a plain HTTP server fails)', () =>
    Effect.gen(function* () {
      const stub = yield* httpStub((_req, res) => {
        res.end('plain');
      });
      const client = yield* HfHttp;
      const error = yield* client.get(Str.replace('http:', 'https:')(stub.url)).pipe(Effect.scoped, Effect.flip);
      assert.strictEqual(error.reason._tag, 'TransportError');
    }).pipe(withHfHttp({})),
  );

  it.live('the requests are HTTP/1.1', () =>
    Effect.gen(function* () {
      const versions: Array<string> = [];
      const stub = yield* httpStub((req, res) => {
        versions.push(req.httpVersion);
        res.end('ok');
      });
      const text = yield* textOf(stub.url);
      assert.strictEqual(text, 'ok');
      assert.deepStrictEqual(versions, ['1.1']);
    }).pipe(withHfHttp({})),
  );

  it.live('a request goes through the proxy of the environment, loopback and NO_PROXY hosts direct', () =>
    Effect.gen(function* () {
      const proxied: Array<string | undefined> = [];
      const proxy = yield* httpStub((req, res) => {
        proxied.push(req.url);
        res.end(`proxy ${req.url}`);
      });
      const local = yield* httpStub((_req, res) => {
        res.end('direct');
      });
      const texts = yield* Effect.all([
        textOf('http://hub.invalid/api/models'),
        textOf(`${local.url}/health`),
        textOf('http://skipped.invalid/'),
      ]).pipe(withHfHttp({ HTTP_PROXY: proxy.url, HTTPS_PROXY: proxy.url, NO_PROXY: 'skipped.invalid' }));
      assert.deepStrictEqual(texts, ['proxy http://hub.invalid/api/models', 'direct', 'TransportError']);
      assert.deepStrictEqual(proxied, ['http://hub.invalid/api/models']);
    }),
  );

  it.live('an https request goes to HTTPS_PROXY as a CONNECT of its host, a refused tunnel fails it (#124)', () =>
    Effect.gen(function* () {
      const proxy = yield* connectStub;
      const errors = yield* Effect.all([
        textOf('https://hub.invalid/api/models'),
        textOf('https://cdn.invalid:8443/file'),
        textOf('https://skipped.invalid/'),
      ]).pipe(withHfHttp({ HTTPS_PROXY: proxy.url, NO_PROXY: 'skipped.invalid' }));
      assert.deepStrictEqual(errors, ['TransportError', 'TransportError', 'TransportError']);
      // The NO_PROXY host went direct (and found no such host): no tunnel asked for it.
      assert.deepStrictEqual(proxy.connects(), ['hub.invalid:443', 'cdn.invalid:8443']);
      assert.strictEqual(proxy.requests(), 0);
    }),
  );

  it.live('no proxy variable, nothing goes to a proxy', () =>
    Effect.gen(function* () {
      const proxy = yield* httpStub((_req, res) => {
        res.end('proxy');
      });
      const local = yield* httpStub((_req, res) => {
        res.end('direct');
      });
      // Node's own agents and `fetch` go through the proxy: HfHttp reads its configuration, not them.
      yield* proxiedEnvironment(proxy.url);
      const texts = yield* Effect.all([textOf(`${local.url}/x`), textOf('http://hub.invalid/x')]).pipe(
        withHfHttp({ NO_PROXY: 'example.com' }),
      );
      assert.deepStrictEqual(texts, ['direct', 'TransportError']);
      assert.strictEqual(proxy.requests(), 0);
    }),
  );

  it.live(
    'a silence of 3 s before the headers and between two chunks does not end the request',
    () =>
      Effect.gen(function* () {
        const SILENCE = 3000;
        const stub = yield* httpStub((req, res) => {
          if (req.url === '/late-headers') {
            later(SILENCE, () => res.writeHead(200).end('late'));
            return;
          }
          res.writeHead(200).write('first ');
          later(SILENCE, () => res.end('second'));
        });
        // Both at once: one silence before the headers, one between two chunks.
        const texts = yield* Effect.all([textOf(`${stub.url}/late-headers`), textOf(`${stub.url}/late-chunk`)], {
          concurrency: 2,
        });
        assert.deepStrictEqual(texts, ['late', 'first second']);
      }).pipe(withHfHttp({})),
    { timeout: 10_000 },
  );

  it.live('with LLAMA_WEBUI_TEST_OFFLINE=1 every request fails with fetch failed', () =>
    Effect.gen(function* () {
      const stub = yield* httpStub((_req, res) => {
        res.end('online');
      });
      const error = yield* Effect.gen(function* () {
        const client = yield* HfHttp;
        return yield* client.get(stub.url).pipe(Effect.scoped, Effect.flip);
      }).pipe(withHfHttp({ LLAMA_WEBUI_TEST_OFFLINE: '1' }));
      assert.strictEqual(error.reason._tag, 'TransportError');
      assert.strictEqual(error.reason._tag === 'TransportError' ? error.reason.description : null, 'fetch failed');
      assert.strictEqual(stub.requests(), 0);
      // The exact value only.
      const online = yield* textOf(stub.url).pipe(withHfHttp({ LLAMA_WEBUI_TEST_OFFLINE: 'true' }));
      assert.strictEqual(online, 'online');
      assert.strictEqual(stub.requests(), 1);
    }),
  );
});
