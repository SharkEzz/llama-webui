import { assert, layer } from '@effect/vitest';
import { IdParam, RequestErrors } from '@llama-webui/shared';
import { Array as Arr, Effect, Layer, Logger, Schema } from 'effect';
import { HttpClient, HttpClientRequest, HttpClientResponse } from 'effect/http';
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup } from 'effect/http-api';
import { ServerTest } from '../testing/http.ts';
import { serve } from './HttpLive.ts';
import { RequestErrorsLive } from './RequestErrors.ts';

const Thing = Schema.Struct({
  name: Schema.String.check(Schema.isMinLength(1, { message: 'cannot be empty' })),
});

/** An API of two endpoints, annotated and given the middleware as `Api` is. */
class TestApi extends HttpApi.make('test')
  .add(
    HttpApiGroup.make('things').add(
      HttpApiEndpoint.post('create', '/api/things', { payload: Thing, success: Thing }),
      HttpApiEndpoint.get('get', '/api/things/:id', { params: { id: IdParam }, success: Schema.Int }),
    ),
  )
  .annotate(HttpApi.PayloadParseOptions, { onExcessProperty: 'error', errors: 'all' })
  .middleware(RequestErrors) {}

const Things = HttpApiBuilder.group(TestApi, 'things', (handlers) =>
  Effect.succeed(
    handlers
      .handle('create', ({ payload }) => Effect.succeed(payload))
      .handle('get', ({ params }) => Effect.succeed(params.id)),
  ),
);

/** The messages the server logged at error level. */
const errors: Array<unknown> = [];
const Errors = Logger.layer([
  Logger.make(({ logLevel, message }) => {
    if (logLevel === 'Error') errors.push(message);
  }),
]);

const TestApp = serve(HttpApiBuilder.layer(TestApi).pipe(Layer.provide(Things), Layer.provide(RequestErrorsLive))).pipe(
  Layer.provideMerge(ServerTest),
  Layer.provide(Errors),
);

/** The fields of a `RequestInvalid` the tests read. */
const Refusal = Schema.Struct({
  _tag: Schema.String,
  message: Schema.String,
  issues: Schema.Array(Schema.Struct({ path: Schema.Array(Schema.String) })),
});

const post = (text: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const res = yield* client.execute(
      HttpClientRequest.post('/api/things').pipe(HttpClientRequest.bodyText(text, 'application/json')),
    );
    const body = yield* HttpClientResponse.schemaBodyJson(Refusal)(res);
    return { status: res.status, body };
  });

layer(TestApp)('RequestErrors', (it) => {
  it.effect('a payload that does not decode is a 400 RequestInvalid with every issue', () =>
    Effect.gen(function* () {
      const { status, body } = yield* post('{"name":"","extra":1}');
      assert.strictEqual(status, 400);
      assert.strictEqual(body._tag, 'RequestInvalid');
      assert.sameDeepMembers(
        Arr.map(body.issues, (issue) => issue.path),
        [['extra'], ['name']],
      );
    }),
  );

  it.effect('a body that is not JSON, is empty or is not an object is a 400 RequestInvalid, never an empty 400', () =>
    Effect.gen(function* () {
      const malformed = yield* post('{');
      assert.strictEqual(malformed.status, 400);
      assert.strictEqual(malformed.body._tag, 'RequestInvalid');
      assert.strictEqual(malformed.body.message, 'Invalid data: Expected a valid JSON body');
      for (const text of ['', '[1]']) {
        const { status, body } = yield* post(text);
        assert.strictEqual(status, 400, text);
        assert.strictEqual(body._tag, 'RequestInvalid', text);
        assert.deepStrictEqual(
          Arr.map(body.issues, (issue) => issue.path),
          [[]],
          text,
        );
      }
    }),
  );

  it.effect('a path parameter that does not decode is the 404 of an unknown route', () =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      for (const path of ['/api/things/abc', '/api/things/0']) {
        const res = yield* client.get(path);
        assert.strictEqual(res.status, 404, path);
        const body = yield* res.json;
        assert.deepStrictEqual(body, { _tag: 'RouteNotFound', message: 'Unknown route' }, path);
      }
      const found = yield* client.get('/api/things/12');
      assert.strictEqual(found.status, 200);
      const id = yield* found.json;
      assert.strictEqual(id, 12);
    }),
  );

  it.effect('a refused request is not logged as a failure', () =>
    Effect.gen(function* () {
      yield* post('{"name":""}');
      const client = yield* HttpClient.HttpClient;
      yield* client.get('/api/things/abc');
      assert.deepStrictEqual(errors, []);
    }),
  );
});
