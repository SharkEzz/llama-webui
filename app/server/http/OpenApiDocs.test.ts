import { assert, layer } from '@effect/vitest';
import { Effect, Layer, Predicate, Record as Rec, Stream } from 'effect';
import { HttpClient, HttpClientRequest } from 'effect/http';
import { VERSION } from '../config/AppInfo.ts';
import { ServerTest } from '../testing/http.ts';
import { PublicTest } from '../testing/public.ts';
import { ServicesTest } from '../testing/services.ts';
import { ApiRoutes, serve } from './HttpLive.ts';

const TestApp = serve(Layer.mergeAll(ApiRoutes, PublicTest)).pipe(
  Layer.provide(ServicesTest),
  Layer.provideMerge(ServerTest),
);

const isRecord = (value: unknown): value is Record<string, unknown> => Predicate.isObject(value);

layer(TestApp, { excludeTestServices: true })('OpenApiDocs', (it) => {
  it.effect('GET /api/openapi.json serves the annotated OpenAPI 3.1 spec and supports gzip', () =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const res = yield* client.get('/api/openapi.json');
      assert.strictEqual(res.status, 200);
      assert.include(res.headers['content-type'] ?? '', 'application/json');
      const plainText = yield* res.text;
      const res2 = yield* client.get('/api/openapi.json');
      const body: unknown = yield* res2.json;
      assert.isTrue(isRecord(body));
      if (!isRecord(body)) return;
      assert.strictEqual(body.openapi, '3.1.0');
      assert.isTrue(isRecord(body.info));
      if (isRecord(body.info)) {
        assert.strictEqual(body.info.title, 'llama-webui API');
        assert.strictEqual(body.info.version, VERSION);
      }
      assert.isTrue(isRecord(body.paths));
      if (isRecord(body.paths)) {
        assert.isAtLeast(Rec.keys(body.paths).length, 55);
        assert.isDefined(body.paths['/api/health']);
        assert.isDefined(body.paths['/api/profiles/{id}']);
        assert.isDefined(body.paths['/api/chat/{id}/messages']);
      }

      const gz = yield* client.execute(
        HttpClientRequest.get('/api/openapi.json').pipe(HttpClientRequest.setHeader('accept-encoding', 'gzip')),
      );
      assert.strictEqual(gz.status, 200);
      assert.strictEqual(gz.headers['content-encoding'], 'gzip');
      const decompressed = yield* gz.stream.pipe(
        Stream.toReadableStream,
        (stream) => stream.pipeThrough(new DecompressionStream('gzip')),
        (stream) => Stream.fromReadableStream({ evaluate: () => stream, onError: () => 'not gzip' as const }),
        Stream.decodeText,
        Stream.mkString,
      );
      assert.strictEqual(decompressed, plainText);
    }),
  );

  it.effect('GET /api/docs serves the offline Scalar UI without external CDN references', () =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const res = yield* client.get('/api/docs');
      assert.strictEqual(res.status, 200);
      assert.include(res.headers['content-type'] ?? '', 'text/html');
      const html = yield* res.text;
      assert.include(html, 'window.Scalar.createApiReference');
      assert.include(html, '"withDefaultFonts":false');
      assert.include(html, '"agent":{"disabled":true}');
      assert.include(html, '"title":"llama-webui API"');
      assert.include(html, `"version":"${VERSION}"`);
      assert.notInclude(html, '<script src=');
      assert.notInclude(html, 'cdn.jsdelivr.net');
    }),
  );

  it.effect('docs routes sit behind the local guard, trailing-slash redirect and method routing', () =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;

      for (const path of ['/api/docs', '/api/openapi.json']) {
        const badHost = yield* client.execute(
          HttpClientRequest.get(path).pipe(HttpClientRequest.setHeader('host', 'evil.example')),
        );
        assert.strictEqual(badHost.status, 403, `${path} host`);
        const badHostBody = yield* badHost.json;
        assert.deepStrictEqual(badHostBody, { _tag: 'RequestRefused', message: 'Host not allowed' });

        const badOrigin = yield* client.execute(
          HttpClientRequest.get(path).pipe(HttpClientRequest.setHeader('origin', 'http://evil.example')),
        );
        assert.strictEqual(badOrigin.status, 403, `${path} origin`);

        const trailing = yield* client.get(`${path}/`);
        assert.strictEqual(trailing.status, 308, `${path}/ trailing slash`);
        assert.strictEqual(trailing.headers.location, path);

        const wrongMethod = yield* client.execute(HttpClientRequest.post(path));
        assert.strictEqual(wrongMethod.status, 404, `POST ${path}`);
        const wrongMethodBody = yield* wrongMethod.json;
        assert.deepStrictEqual(wrongMethodBody, { _tag: 'RouteNotFound', message: 'Unknown route' });
      }
    }),
  );
});
