import { assert, layer } from '@effect/vitest';
import { Array as Arr, Effect, Layer, Logger, Metric, Schedule, Stream, String as Str } from 'effect';
import { HttpClient, HttpClientRequest, HttpRouter, HttpServerResponse } from 'effect/http';
import { HttpMetrics } from '../runtime/Metrics.ts';
import { ServerTest } from '../testing/http.ts';
import { PublicTest } from '../testing/public.ts';
import { ServicesTest } from '../testing/services.ts';
import { WsHub } from '../ws/WsHub.ts';
import { ApiRoutes, serve } from './HttpLive.ts';
import { sseResponse } from './Sse.ts';

const Boom = HttpRouter.add('GET', '/api/boom', Effect.die(new Error('secret')));

/** A JSON of 4 KiB and a stream of events of as much, outside the API: the compression is the server's, not a group's. */
const BIG = { rows: Arr.makeBy(128, (i) => ({ id: i, name: `model-${i}.gguf` })) };
const Big = Layer.mergeAll(
  HttpRouter.add('GET', '/big', HttpServerResponse.json(BIG)),
  HttpRouter.add('GET', '/events', sseResponse(Stream.make({ data: Str.repeat(4096)('x') }))),
);

/** The messages the server logged at error level. */
const errors: Array<unknown> = [];
const Errors = Logger.layer([
  Logger.make(({ logLevel, message }) => {
    if (logLevel === 'Error') errors.push(message);
  }),
]);

/** The count of `metric`, once it reaches `n`: a response is measured after it is written. */
const countReaches = (metric: Metric.Counter<number>, n: number) =>
  Metric.value(metric).pipe(
    Effect.repeat({ until: (state) => state.count >= n, schedule: Schedule.spaced('10 millis') }),
    Effect.timeout('2 seconds'),
    Effect.map((state) => state.count),
  );

/** The API, /ws, a route that dies, the big replies, and a UI of one page, served as the app serves them. */
const TestApp = serve(Layer.mergeAll(ApiRoutes, WsHub.route, Boom, Big, PublicTest)).pipe(
  Layer.provide(ServicesTest),
  Layer.provideMerge(ServerTest),
  Layer.provide(Errors),
);

// On the real clock: a measure is waited for.
layer(TestApp, { excludeTestServices: true })('HttpLive', (it) => {
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

  it.effect('a path the router reads as an API route or /ws is guarded however it is spelled', () =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      // The router ignores the case, folds repeated slashes, decodes percent escapes and cuts the path at a `;`.
      for (const path of ['/API/health', '//api/health', '/%61pi/health', '/api/health;x', '/Api//Settings']) {
        const host = yield* client.execute(
          HttpClientRequest.get(path).pipe(HttpClientRequest.setHeader('host', 'evil.example')),
        );
        assert.strictEqual(host.status, 403, `${path} (host)`);
        const origin = yield* client.execute(
          HttpClientRequest.get(path).pipe(HttpClientRequest.setHeader('origin', 'http://evil.example')),
        );
        assert.strictEqual(origin.status, 403, `${path} (origin)`);
      }
      for (const path of ['//api/server/stop', '/API/server/stop', '/%61pi/server/stop']) {
        const write = yield* client.execute(
          HttpClientRequest.post(path).pipe(HttpClientRequest.bodyText('{}', 'text/plain')),
        );
        assert.strictEqual(write.status, 415, path);
      }
      for (const path of ['/WS', '//ws', '/%77s', '/ws;x']) {
        const ws = yield* client.execute(
          HttpClientRequest.get(path).pipe(
            HttpClientRequest.setHeaders({
              origin: 'https://evil.example',
              connection: 'Upgrade',
              upgrade: 'websocket',
            }),
          ),
        );
        assert.strictEqual(ws.status, 403, path);
        assert.strictEqual(ws.headers.connection, 'close', path);
      }
    }),
  );

  it.effect('a payload that does not decode is a 400, not logged as a failure', () =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const logged = errors.length;
      for (const body of ['[1]', '{bad']) {
        const res = yield* client.execute(
          HttpClientRequest.patch('/api/settings').pipe(HttpClientRequest.bodyText(body, 'application/json')),
        );
        assert.strictEqual(res.status, 400, body);
      }
      assert.strictEqual(errors.length, logged);
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

  it.effect('every response is counted by method and class of status, a defect too', () =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const ok = Metric.withAttributes(HttpMetrics.requests, { method: 'GET', class: '2xx' });
      const missing = Metric.withAttributes(HttpMetrics.requests, { method: 'POST', class: '4xx' });
      const failed = Metric.withAttributes(HttpMetrics.requests, { method: 'GET', class: '5xx' });
      const before = {
        ok: (yield* Metric.value(ok)).count,
        missing: (yield* Metric.value(missing)).count,
        failed: (yield* Metric.value(failed)).count,
        defects: (yield* Metric.value(HttpMetrics.defects)).count,
        invalid: (yield* Metric.value(HttpMetrics.invalid)).occurrences.get('Payload') ?? 0,
      };
      yield* client.get('/api/health');
      yield* client.execute(HttpClientRequest.post('/api/nope'));
      yield* client.get('/api/boom');
      yield* client.execute(
        HttpClientRequest.patch('/api/settings').pipe(HttpClientRequest.bodyText('[1]', 'application/json')),
      );
      const after = {
        ok: yield* countReaches(ok, before.ok + 1),
        missing: yield* countReaches(missing, before.missing + 1),
        failed: yield* countReaches(failed, before.failed + 1),
        defects: yield* countReaches(HttpMetrics.defects, before.defects + 1),
      };
      assert.deepStrictEqual(after, {
        ok: before.ok + 1,
        missing: before.missing + 1,
        failed: before.failed + 1,
        defects: before.defects + 1,
      });
      const invalid = yield* Metric.value(HttpMetrics.invalid);
      assert.strictEqual(invalid.occurrences.get('Payload'), before.invalid + 1);
    }),
  );

  it.effect('a JSON of 1 KiB or more goes out in gzip to a client that accepts it, nothing else does (#105)', () =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const get = (path: string, encoding?: string) =>
        client.execute(
          encoding === undefined
            ? HttpClientRequest.get(path)
            : HttpClientRequest.get(path).pipe(HttpClientRequest.setHeader('accept-encoding', encoding)),
        );
      const big = yield* get('/big', 'gzip, deflate, br');
      assert.strictEqual(big.headers['content-encoding'], 'gzip');
      assert.strictEqual(big.headers.vary, 'Accept-Encoding');
      const gzipped = yield* big.stream.pipe(
        Stream.toReadableStream,
        (body) => body.pipeThrough(new DecompressionStream('gzip')),
        (body) => Stream.fromReadableStream({ evaluate: () => body, onError: () => 'not gzip' as const }),
        Stream.decodeText,
        Stream.mkString,
      );
      const plain = yield* get('/big');
      assert.isUndefined(plain.headers['content-encoding']);
      const text = yield* plain.text;
      assert.strictEqual(gzipped, text);
      assert.isAbove(text.length, 4096);
      // Under 1 KiB, a client that refuses gzip, a stream of events: as written.
      for (const [path, encoding] of [
        ['/api/health', 'gzip'],
        ['/big', 'gzip;q=0, br'],
        ['/events', 'gzip'],
      ] as const) {
        const res = yield* get(path, encoding);
        assert.isUndefined(res.headers['content-encoding'], path);
        yield* res.text;
      }
    }),
  );
});
