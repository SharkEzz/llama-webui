import { assert, layer } from '@effect/vitest';
import { Effect, Option, Stream } from 'effect';
import { freePort, httpStub, later, until } from '../testing/llama.ts';
import { streamChat } from './chatStream.ts';
import { LlamaHttp } from './LlamaHttp.ts';

type StubRequest = Parameters<Parameters<typeof httpStub>[0]>[0];

/** The body of a request the stub received, once it has all arrived. */
const bodyOf = (req: StubRequest, done: (body: string) => void) => {
  const chunks: Array<Buffer> = [];
  req.on('data', (chunk: Buffer) => chunks.push(chunk));
  req.on('end', () => done(Buffer.concat(chunks).toString()));
};

const delta = (content: string) => `data: {"choices":[{"delta":{"content":"${content}"}}]}\n\n`;

layer(LlamaHttp.layer, { excludeTestServices: true })('streamChat', (it) => {
  it.effect('streamChat streams the deltas and the timings until [DONE]', () =>
    Effect.gen(function* () {
      const seen: Array<unknown> = [];
      const stub = yield* httpStub((req, res) => {
        bodyOf(req, (body) => {
          seen.push([req.method, req.url, req.headers['content-type'], body]);
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.write('data: {"choices":[{"delta":{"role":"assistant","content":null}}]}\n\n');
          res.write(': a comment\n\ndata: {"choices":[{"delta":{"reasoning_content":"They say hi."}}]}\r\n\r\n');
          // One event split across two writes.
          res.write('data: {"choices":[{"delta":{"con');
          later(10, () => {
            res.write('tent":"Hel"}}]}\n\n');
            res.write('data: not json\n\n');
            res.write('data: {"choices":[{"delta":{"content":5}}]}\n\n');
            res.write(delta('lo'));
            res.write(
              'data: {"choices":[{"delta":{}}],"timings":{"prompt_n":3,"prompt_per_second":30,"predicted_n":2,"predicted_per_second":20,"cache_n":1}}\n\n',
            );
            res.write('data: [DONE]\n\n');
            res.write(delta('after the end'));
          });
        });
      });
      const chunks = yield* streamChat(stub.url, { messages: [{ role: 'user', content: 'Hi' }], stream: true }).pipe(
        Stream.runCollect,
      );
      assert.deepStrictEqual(seen, [
        [
          'POST',
          '/v1/chat/completions',
          'application/json',
          '{"messages":[{"role":"user","content":"Hi"}],"stream":true}',
        ],
      ]);
      assert.deepStrictEqual(chunks, [
        { choices: [{ delta: { content: null } }] },
        { choices: [{ delta: { reasoning_content: 'They say hi.' } }] },
        { choices: [{ delta: { content: 'Hel' } }] },
        { choices: [{ delta: { content: 'lo' } }] },
        {
          choices: [{ delta: {} }],
          timings: { prompt_n: 3, prompt_per_second: 30, predicted_n: 2, predicted_per_second: 20, cache_n: 1 },
        },
      ]);
      // The response never ended: the end of the stream aborted the request.
      yield* until(() => stub.closes() === 1);
    }),
  );

  it.effect('an error status with a JSON error is LlamaHttpFailed with that error', () =>
    Effect.gen(function* () {
      const body =
        '{"error":{"code":400,"message":"too long","type":"exceed_context_size_error","n_prompt_tokens":50,"n_ctx":40}}';
      const stub = yield* httpStub((req, res) => {
        res.writeHead(req.url === '/v1/chat/completions' ? 400 : 404, { 'content-type': 'application/json' }).end(body);
      });
      const error = yield* streamChat(stub.url, {}).pipe(Stream.runCollect, Effect.flip);
      assert.strictEqual(error._tag, 'LlamaHttpFailed');
      if (error._tag !== 'LlamaHttpFailed') return;
      assert.strictEqual(error.status, 400);
      assert.strictEqual(error.body, body);
      assert.deepStrictEqual(
        error.error,
        Option.some({
          code: 400,
          message: 'too long',
          type: 'exceed_context_size_error',
          n_prompt_tokens: 50,
          n_ctx: 40,
        }),
      );

      const plain = yield* httpStub((_req, res) => {
        res.writeHead(503, { 'content-type': 'application/json' }).end('{"error":"loading"}');
      });
      const loading = yield* streamChat(plain.url, {}).pipe(Stream.runCollect, Effect.flip);
      assert.deepStrictEqual(
        loading._tag === 'LlamaHttpFailed' ? [loading.status, loading.body, loading.error] : loading,
        [503, '{"error":"loading"}', Option.none()],
      );
    }),
  );

  it.effect('a stream error event is LlamaStreamFailed', () =>
    Effect.gen(function* () {
      const stub = yield* httpStub((_req, res) => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(delta('a'));
        res.write('data: {"error":{"code":500,"message":"boom","type":"server_error"}}\n\n');
      });
      const seen: Array<unknown> = [];
      const error = yield* streamChat(stub.url, {}).pipe(
        Stream.runForEach((chunk) => Effect.sync(() => seen.push(chunk))),
        Effect.flip,
      );
      assert.deepStrictEqual(seen, [{ choices: [{ delta: { content: 'a' } }] }]);
      assert.strictEqual(error._tag, 'LlamaStreamFailed');
      if (error._tag !== 'LlamaStreamFailed') return;
      assert.deepStrictEqual(error.error, { code: 500, message: 'boom', type: 'server_error' });
      yield* until(() => stub.closes() === 1);
    }),
  );

  it.effect('a body that ends before [DONE] is LlamaStreamCut', () =>
    Effect.gen(function* () {
      let requests = 0;
      const stub = yield* httpStub((_req, res) => {
        requests++;
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(delta('a'));
        // The first response ends cleanly, the second is cut.
        later(10, () => (requests === 1 ? res.end() : res.destroy()));
      });
      const ended = yield* streamChat(stub.url, {}).pipe(Stream.runCollect, Effect.flip);
      assert.strictEqual(ended._tag, 'LlamaStreamCut');
      // The connection cut in the middle of the body.
      const broken = yield* streamChat(stub.url, {}).pipe(Stream.runCollect, Effect.flip);
      assert.strictEqual(broken._tag, 'LlamaStreamCut');
      assert.strictEqual(stub.requests(), 2);
    }),
  );

  it.effect('nothing listening is LlamaUnreachable', () =>
    Effect.gen(function* () {
      const port = yield* freePort;
      const error = yield* streamChat(`http://127.0.0.1:${port}`, {}).pipe(Stream.runCollect, Effect.flip);
      assert.strictEqual(error._tag, 'LlamaUnreachable');
      if (error._tag !== 'LlamaUnreachable') return;
      assert.include(error.message, 'ECONNREFUSED');
    }),
  );

  it.effect('streamChat streams through LlamaHttp and stops the request when left early', () =>
    Effect.gen(function* () {
      let closed = false;
      const stub = yield* httpStub((req, res) => {
        bodyOf(req, (body) => {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.write(delta(body === '{"stream":true}' ? 'stream=true' : body));
          later(10, () => res.write(delta('b')));
          req.socket.once('close', () => {
            closed = true;
          });
        });
      });
      const seen = yield* streamChat(stub.url, { stream: true }).pipe(
        Stream.map((chunk) => chunk.choices?.[0]?.delta?.content ?? ''),
        Stream.take(2),
        Stream.runCollect,
      );
      assert.deepStrictEqual(seen, ['stream=true', 'b']);
      yield* until(() => closed);
    }),
  );
});
