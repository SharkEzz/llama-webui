import { assert, layer } from '@effect/vitest';
import { LogLine } from '@llama-webui/shared';
import { Array as Arr, Effect, Layer, Schema } from 'effect';
import { HttpClient, HttpClientResponse } from 'effect/http';
import { ApiRoutes, serve } from '../http/HttpLive.ts';
import { ServerTest } from '../testing/http.ts';
import { ServicesTest } from '../testing/services.ts';
import { LogRing } from './LogRing.ts';

/** The API as the app serves it, on a real server. */
const Served = serve(ApiRoutes).pipe(Layer.provideMerge(ServicesTest), Layer.provideMerge(ServerTest));

const Logs = Schema.Struct({ lines: Schema.Array(LogLine), seq: Schema.Int, bootId: Schema.String });
const Health = Schema.Struct({ bootId: Schema.String });
const Refused = Schema.TaggedStruct('RequestInvalid', { message: Schema.String });

/** The status and the body of a GET, read with `schema`. */
const get = <A, I>(path: string, schema: Schema.Codec<A, I>) =>
  Effect.gen(function* () {
    const res = yield* HttpClient.get(path);
    const body = yield* HttpClientResponse.schemaBodyJson(schema)(res);
    return { status: res.status, body };
  });

layer(Served)('LogsApi over HTTP', (it) => {
  it.effect('GET /api/logs answers the lines from since, the next number and the boot id', () =>
    Effect.gen(function* () {
      const ring = yield* LogRing;
      yield* Effect.forEach(['first', 'second', 'third'], ring.push, { discard: true });
      const logs = yield* get('/api/logs?since=1', Logs);
      const health = yield* get('/api/health', Health);
      assert.strictEqual(logs.status, 200);
      assert.deepStrictEqual(
        Arr.map(logs.body.lines, (line) => line.text),
        ['second', 'third'],
      );
      assert.strictEqual(logs.body.seq, 3);
      assert.strictEqual(logs.body.bootId, health.body.bootId);
    }),
  );

  it.effect('since=-1 and since=abc are a 400 RequestInvalid', () =>
    Effect.gen(function* () {
      for (const since of ['-1', 'abc']) {
        const refused = yield* get(`/api/logs?since=${since}`, Refused);
        assert.strictEqual(refused.status, 400);
      }
    }),
  );
});
