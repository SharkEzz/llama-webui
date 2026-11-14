import { assert, layer } from '@effect/vitest';
import { Effect, Layer } from 'effect';
import { HttpClient } from 'effect/http';
import { AppInfo } from '../config/AppInfo.ts';
import { ServerTest } from '../testing/http.ts';
import { PUBLIC, PublicTest } from '../testing/public.ts';
import { ApiRoutes, serve } from './HttpLive.ts';

const TestApp = serve(Layer.merge(ApiRoutes, PublicTest)).pipe(
  Layer.provide(AppInfo.layer),
  Layer.provideMerge(ServerTest),
);

layer(TestApp)('Static', (it) => {
  it.effect('pages are revalidated, hashed assets are immutable, the API sets no cache header', () =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      for (const path of ['/', '/chat/12', '/index.html']) {
        const page = yield* client.get(path);
        assert.strictEqual(page.status, 200, path);
        assert.strictEqual(page.headers['cache-control'], 'no-cache', path);
        assert.match(page.headers['content-type'] ?? '', /^text\/html/, path);
        const text = yield* page.text;
        assert.strictEqual(text, PUBLIC['index.html'], path);
      }
      const asset = yield* client.get('/assets/a-1234.js');
      assert.strictEqual(asset.status, 200);
      assert.match(asset.headers['cache-control'] ?? '', /immutable/);
      const health = yield* client.get('/api/health');
      assert.strictEqual(health.status, 200);
      assert.isUndefined(health.headers['cache-control']);
    }),
  );

  it.effect('a missing asset is a 404, not the page', () =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const res = yield* client.get('/assets/gone-9999.js');
      assert.strictEqual(res.status, 404);
      const text = yield* res.text;
      assert.notInclude(text, '<!doctype html>');
    }),
  );

  it.effect('a file of the root is served as itself', () =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const res = yield* client.get('/favicon.svg');
      assert.strictEqual(res.status, 200);
      assert.match(res.headers['content-type'] ?? '', /^image\/svg\+xml/);
      assert.strictEqual(res.headers['cache-control'], 'no-cache');
      const text = yield* res.text;
      assert.strictEqual(text, PUBLIC['favicon.svg']);
    }),
  );
});
