import { assert, layer } from '@effect/vitest';
import { Array as Arr, Clock, Effect, Option } from 'effect';
import { freePort, httpStub, until } from '../testing/llama.ts';
import { LlamaHttp } from './LlamaHttp.ts';
import { health, isLlamaServer, props } from './probes.ts';

/** A stub that answers every request with `status` and `body`. */
const answering = (status: number, body: string, type = 'application/json') =>
  httpStub((_req, res) => {
    res.writeHead(status, { 'content-type': type }).end(body);
  });

layer(LlamaHttp.layer, { excludeTestServices: true })('probes', (it) => {
  it.effect('health is the status, none when nothing listens or nothing answers within 800 ms', () =>
    Effect.gen(function* () {
      const ok = yield* answering(200, '{"status":"ok"}');
      const loading = yield* answering(503, '{"error":{"type":"unavailable_error"}}');
      const closed = yield* freePort;
      const silent = yield* httpStub(() => {});
      const statuses = yield* Effect.forEach([ok.port, loading.port, closed], (port) => health({ port }));
      assert.deepStrictEqual(statuses, [Option.some(200), Option.some(503), Option.none()]);
      const start = yield* Clock.currentTimeMillis;
      const none = yield* health({ port: silent.port });
      const end = yield* Clock.currentTimeMillis;
      const waited = end - start;
      assert.deepStrictEqual(none, Option.none());
      assert.isAtLeast(waited, 750);
      assert.isBelow(waited, 1500);
      yield* until(() => silent.closes() === 1);
    }),
  );

  it.effect('health reaches loopback for a wildcard host', () =>
    Effect.gen(function* () {
      const ok = yield* answering(200, '{"status":"ok"}');
      const statuses = yield* Effect.forEach(['0.0.0.0', '', undefined, null], (host) =>
        health({ host, port: ok.port }),
      );
      assert.deepStrictEqual(statuses, Arr.replicate(Option.some(200), 4));
    }),
  );

  it.effect(
    'isLlamaServer: {"status":"ok"} and an unavailable_error are one, a web page and a JSON array are not (#28)',
    () =>
      Effect.gen(function* () {
        const ready = yield* answering(200, '{"status":"ok"}');
        const loading = yield* answering(
          503,
          '{"error":{"code":503,"message":"Loading model","type":"unavailable_error"}}',
        );
        const page = yield* answering(200, '<!doctype html><title>Hi</title>', 'text/html');
        const array = yield* answering(200, '[{"status":"ok"}]');
        const port = yield* freePort;
        const answers = yield* Effect.forEach([ready.port, loading.port, page.port, array.port, port], (port) =>
          isLlamaServer({ port }),
        );
        assert.deepStrictEqual(answers, [true, true, false, false, false]);
      }),
  );

  it.effect(
    'props: the JSON as it is; an error status, a body that is not JSON and no answer are PropsUnavailable with their message (#37)',
    () =>
      Effect.gen(function* () {
        const good = yield* answering(200, '{"total_slots":2,"model_path":"/m.gguf"}');
        const failing = yield* answering(500, 'boom', 'text/plain');
        const text = yield* answering(200, 'not json', 'text/plain');
        const port = yield* freePort;
        const json = yield* props(good.url);
        assert.deepStrictEqual(json, { total_slots: 2, model_path: '/m.gguf' });
        const refusals = yield* Effect.forEach([failing.url, text.url, `http://127.0.0.1:${port}`], (url) =>
          props(url).pipe(
            Effect.flip,
            Effect.map((error) => [error._tag, error.message]),
          ),
        );
        assert.deepStrictEqual(refusals, [
          ['PropsUnavailable', 'llama-server /props: HTTP 500'],
          ['PropsUnavailable', 'llama-server /props: the reply is not JSON'],
          ['PropsUnavailable', 'llama-server is not responding on /props'],
        ]);
      }),
  );
});
