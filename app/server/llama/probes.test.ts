import { assert, layer } from '@effect/vitest';
import { Array as Arr, Clock, Effect, Option } from 'effect';
import { freePort, httpStub, until } from '../testing/llama.ts';
import { LlamaHttp } from './LlamaHttp.ts';
import { health, isLlamaServer, props, readLlama } from './probes.ts';

/** A stub that answers every request with `status` and `body`. */
const answering = (status: number, body: string, type = 'application/json') =>
  httpStub((_req, res) => {
    res.writeHead(status, { 'content-type': type }).end(body);
  });

/** One busy slot, as llama-server's `/slots` answers it (`testdata/fake/slots-busy.json`). */
const SLOTS =
  '[{"id":0,"n_ctx":40192,"is_processing":true,"id_task":2,"n_prompt_tokens":92,"n_prompt_tokens_processed":68,' +
  '"next_token":[{"has_next_token":true,"n_remain":279,"n_decoded":21}]}]';
const METRICS = Arr.join(
  [
    '# HELP llamacpp:tokens_predicted_total Number of generation tokens processed',
    '# TYPE llamacpp:tokens_predicted_total counter',
    'llamacpp:tokens_predicted_total 300',
    'llamacpp:requests_processing 1',
    '',
  ],
  '\n',
);

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

  it.effect('readLlama reads health, slots and metrics of a loaded server', () =>
    Effect.gen(function* () {
      const server = yield* httpStub((req, res) => {
        if (req.url === '/health') res.writeHead(200, { 'content-type': 'application/json' }).end('{"status":"ok"}');
        else if (req.url === '/slots') res.writeHead(200, { 'content-type': 'application/json' }).end(SLOTS);
        else if (req.url === '/metrics') res.writeHead(200, { 'content-type': 'text/plain' }).end(METRICS);
        else res.writeHead(404).end();
      });
      const before = yield* Clock.currentTimeMillis;
      const raw = yield* readLlama({ host: '0.0.0.0', port: server.port });
      assert.strictEqual(raw.health, 'ok');
      assert.isAtLeast(raw.at, before);
      assert.deepStrictEqual(raw.slots, [
        {
          id: 0,
          nCtx: 40192,
          processing: true,
          idTask: 2,
          nPromptTokens: 92,
          nPromptProcessed: 68,
          nDecoded: 21,
          nRemain: 279,
        },
      ]);
      assert.strictEqual(raw.metrics?.get('llamacpp:tokens_predicted_total'), 300);
      assert.strictEqual(server.requests(), 3);
    }),
  );

  it.effect('readLlama stops at a loading server', () =>
    Effect.gen(function* () {
      const loading = yield* answering(503, '{"error":{"type":"unavailable_error"}}');
      const raw = yield* readLlama({ port: loading.port });
      assert.deepStrictEqual([raw.health, raw.slots, raw.metrics], ['loading', null, null]);
      assert.strictEqual(loading.requests(), 1);
      const failing = yield* answering(500, 'boom', 'text/plain');
      const error = yield* readLlama({ port: failing.port });
      assert.deepStrictEqual([error.health, error.slots, error.metrics], ['error', null, null]);
    }),
  );

  it.effect('a llama-server that never answers gives health down within a second', () =>
    Effect.gen(function* () {
      const silent = yield* httpStub(() => {});
      const start = yield* Clock.currentTimeMillis;
      const raw = yield* readLlama({ port: silent.port });
      const waited = (yield* Clock.currentTimeMillis) - start;
      assert.deepStrictEqual([raw.health, raw.slots, raw.metrics], ['down', null, null]);
      assert.isAtLeast(waited, 750);
      assert.isBelow(waited, 1000);
      // Health answered, then /slots and /metrics silent: each gives up after 800 ms, together.
      const halfSilent = yield* httpStub((req, res) => {
        if (req.url === '/health') res.writeHead(200).end('{"status":"ok"}');
      });
      const t0 = yield* Clock.currentTimeMillis;
      const partial = yield* readLlama({ port: halfSilent.port });
      const took = (yield* Clock.currentTimeMillis) - t0;
      assert.deepStrictEqual([partial.health, partial.slots, partial.metrics], ['ok', null, null]);
      assert.isBelow(took, 1500);
    }),
  );
});
