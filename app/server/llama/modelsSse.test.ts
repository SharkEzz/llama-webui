import { assert, layer } from '@effect/vitest';
import { Effect, Stream } from 'effect';
import { freePort, httpStub } from '../testing/llama.ts';
import { LlamaHttp } from './LlamaHttp.ts';
import { sanitizeLoadProgress, streamModelsSse } from './modelsSse.ts';

const LOADING_FRAME =
  'data: {"model":"qwen","event":"status_change","data":{"status":"loading","progress":{"stages":["text_model"],"current":"text_model","value":0.5}}}\n\n';
const LOADED_FRAME =
  'data: {"model":"qwen","event":"status_change","data":{"status":"loaded","info":{"id":"qwen"}}}\n\n';

layer(LlamaHttp.layer, { excludeTestServices: true })('llama/modelsSse', (it) => {
  it.effect('streams status_change events until clean EOF and skips malformed JSON', () =>
    Effect.gen(function* () {
      const stub = yield* httpStub((req, res) => {
        if (req.url !== '/models/sse') {
          res.writeHead(404).end();
          return;
        }
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(LOADING_FRAME);
        res.write('data: {bad json\n\n');
        res.end(LOADED_FRAME);
      });
      const events = yield* streamModelsSse({ host: '127.0.0.1', port: stub.port }).pipe(Stream.runCollect);
      assert.strictEqual(events.length, 2);
      assert.deepStrictEqual(events[0], {
        event: 'status_change',
        model: 'qwen',
        status: 'loading',
        progress: { stages: ['text_model'], current: 'text_model', value: 0.5 },
      });
      assert.deepStrictEqual(events[1], {
        event: 'status_change',
        model: 'qwen',
        status: 'loaded',
        info: { id: 'qwen' },
      });
    }),
  );

  it.effect('fails with ModelsSseUnsupported on 404 or 503', () =>
    Effect.gen(function* () {
      const s404 = yield* httpStub((_, res) => res.writeHead(404).end());
      const s503 = yield* httpStub((_, res) => res.writeHead(503).end('{"error":"loading"}'));
      const r404 = yield* streamModelsSse({ port: s404.port }).pipe(Stream.runCollect, Effect.result);
      const r503 = yield* streamModelsSse({ port: s503.port }).pipe(Stream.runCollect, Effect.result);
      assert.strictEqual(r404._tag, 'Failure');
      if (r404._tag === 'Failure')
        assert.deepStrictEqual(
          [r404.failure._tag, r404.failure._tag === 'ModelsSseUnsupported' ? r404.failure.status : null],
          ['ModelsSseUnsupported', 404],
        );
      assert.strictEqual(r503._tag, 'Failure');
      if (r503._tag === 'Failure')
        assert.deepStrictEqual(
          [r503.failure._tag, r503.failure._tag === 'ModelsSseUnsupported' ? r503.failure.status : null],
          ['ModelsSseUnsupported', 503],
        );
    }),
  );

  it.effect('fails with ModelsSseUnreachable when nothing listens on the port', () =>
    Effect.gen(function* () {
      const port = yield* freePort;
      const r = yield* streamModelsSse({ port }).pipe(Stream.runCollect, Effect.result);
      assert.strictEqual(r._tag, 'Failure');
      if (r._tag === 'Failure') assert.strictEqual(r.failure._tag, 'ModelsSseUnreachable');
    }),
  );

  it.effect('sanitizeLoadProgress clamps values and turns non-finite values into null', () =>
    Effect.sync(() => {
      assert.deepStrictEqual(sanitizeLoadProgress({ stages: ['text_model'], current: 'text_model', value: 1.4 }), {
        stages: ['text_model'],
        current: 'text_model',
        value: 1,
      });
      assert.deepStrictEqual(sanitizeLoadProgress({ stages: [], current: 'mmproj_model', value: Number.NaN }), {
        stages: [],
        current: 'mmproj_model',
        value: null,
      });
    }),
  );
});
