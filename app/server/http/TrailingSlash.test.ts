import { assert, layer } from '@effect/vitest';
import { Effect, Layer } from 'effect';
import { HttpClient, HttpClientRequest } from 'effect/http';
import { ServerTest } from '../testing/http.ts';
import { PublicTest } from '../testing/public.ts';
import { ServicesTest } from '../testing/services.ts';
import { ApiRoutes, serve } from './HttpLive.ts';

/** The API and a UI of one page, served as the app serves them. The client of `ServerTest` follows no redirect. */
const TestApp = serve(Layer.mergeAll(ApiRoutes, PublicTest)).pipe(
  Layer.provide(ServicesTest),
  Layer.provideMerge(ServerTest),
);

/** The status, the location and the body of a reply. */
const send = (request: HttpClientRequest.HttpClientRequest) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const res = yield* client.execute(request);
    const body = yield* res.text;
    return { status: res.status, location: res.headers.location, body };
  });

layer(TestApp)('TrailingSlash', (it) => {
  it.effect('an /api path with a trailing slash is a 308 to the path without it, query kept', () =>
    Effect.gen(function* () {
      const plain = yield* send(HttpClientRequest.get('/api/settings/'));
      assert.deepStrictEqual(plain, { status: 308, location: '/api/settings', body: '' });
      const query = yield* send(HttpClientRequest.get('/api/settings/?a=1&b=/'));
      assert.deepStrictEqual(query, { status: 308, location: '/api/settings?a=1&b=/', body: '' });
      // The method is the client's to replay: a write is redirected too, its body untouched.
      const patch = yield* send(
        HttpClientRequest.patch('/api/settings/').pipe(
          HttpClientRequest.bodyText('{"binary":"x"}', 'application/json'),
        ),
      );
      assert.deepStrictEqual(patch, { status: 308, location: '/api/settings', body: '' });
    }),
  );

  it.effect('every trailing slash goes, and the target stays a path of this server', () =>
    Effect.gen(function* () {
      for (const [path, location] of [
        ['/api/settings//', '/api/settings'],
        ['/api//', '/api'],
        ['/api/', '/api'],
        ['/ws/', '/ws'],
      ] as const) {
        const reply = yield* send(HttpClientRequest.get(path));
        assert.deepStrictEqual(reply, { status: 308, location, body: '' }, path);
      }
    }),
  );

  it.effect('the guard answers first', () =>
    Effect.gen(function* () {
      const reply = yield* send(
        HttpClientRequest.get('/api/settings/').pipe(HttpClientRequest.setHeader('origin', 'http://evil.example')),
      );
      assert.strictEqual(reply.status, 403);
      assert.isUndefined(reply.location);
    }),
  );

  it.effect('a path of the UI keeps its slash', () =>
    Effect.gen(function* () {
      for (const path of ['/profiles/', '/']) {
        const reply = yield* send(HttpClientRequest.get(path));
        assert.strictEqual(reply.status, 200, path);
        assert.isUndefined(reply.location, path);
        assert.include(reply.body, '<title>llama-webui</title>', path);
      }
    }),
  );
});
