import { assert, layer } from '@effect/vitest';
import { Array as Arr, Effect, Layer, Logger } from 'effect';
import { HttpClient, HttpClientRequest, HttpRouter } from 'effect/http';
import { AppInfo } from '../config/AppInfo.ts';
import { ServerTest } from '../testing/http.ts';
import { PublicTest } from '../testing/public.ts';
import { ApiRoutes, serve } from './HttpLive.ts';

const Boom = HttpRouter.add('GET', '/api/boom', Effect.die(new Error('secret')));

/** The messages the server logged at error level. */
const errors: Array<unknown> = [];
const Errors = Logger.layer([
  Logger.make(({ logLevel, message }) => {
    if (logLevel === 'Error') errors.push(message);
  }),
]);

/** The API, a route that dies, and a UI of one page, served as the app serves them. */
const TestApp = serve(Layer.mergeAll(ApiRoutes, Boom, PublicTest)).pipe(
  Layer.provide(AppInfo.layer),
  Layer.provideMerge(ServerTest),
  Layer.provide(Errors),
);

layer(TestApp)('HttpLive', (it) => {
  it.effect('an unknown /api path is a 404 RouteNotFound, not the page', () =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      for (const path of ['/api/nope', '/api', '/api/health/extra']) {
        const res = yield* client.get(path);
        assert.strictEqual(res.status, 404, path);
        const body = yield* res.json;
        assert.deepStrictEqual(body, { _tag: 'RouteNotFound', message: 'Unknown route' }, path);
      }
      const post = yield* client.execute(HttpClientRequest.post('/api/nope'));
      assert.strictEqual(post.status, 404);
      const asset = yield* client.get('/assets/gone-9999.js');
      assert.strictEqual(asset.status, 404);
      // A 404 is an answer, not a defect: nothing is logged.
      assert.deepStrictEqual(errors, []);
    }),
  );

  it.effect('a refused request is answered as JSON, and the UI is not guarded', () =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const page = yield* client.execute(
        HttpClientRequest.get('/').pipe(HttpClientRequest.setHeader('host', 'evil.example')),
      );
      assert.strictEqual(page.status, 200);
      const api = yield* client.execute(
        HttpClientRequest.get('/api/health').pipe(HttpClientRequest.setHeader('host', 'evil.example')),
      );
      assert.strictEqual(api.status, 403);
      const body = yield* api.json;
      assert.deepStrictEqual(body, { _tag: 'RequestRefused', message: 'Host not allowed' });
      const ws = yield* client.execute(
        HttpClientRequest.get('/ws').pipe(
          HttpClientRequest.setHeaders({ origin: 'https://evil.example', connection: 'Upgrade', upgrade: 'websocket' }),
        ),
      );
      assert.strictEqual(ws.status, 403);
      assert.strictEqual(ws.headers.connection, 'close');
    }),
  );

  it.effect('a defect answers 500 without its message, and is logged', () =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const res = yield* client.get('/api/boom');
      assert.strictEqual(res.status, 500);
      const text = yield* res.text;
      assert.notInclude(text, 'secret');
      assert.isTrue(Arr.some(errors, (message) => Arr.contains(Arr.ensure(message), 'a request failed')));
    }),
  );
});
