import { assert, layer } from '@effect/vitest';
import { Effect, Exit, Option, Stream } from 'effect';
import { HttpClientRequest } from 'effect/http';
import { freePort, httpStub, later, nodeFetchText, proxiedEnvironment, until } from '../testing/llama.ts';
import { LlamaHttp } from './LlamaHttp.ts';

const decoder = new TextDecoder();

layer(LlamaHttp.layer, { excludeTestServices: true })('LlamaHttp', (it) => {
  it.effect('sends the method, the headers and the body, and answers the status, the headers and the body', () =>
    Effect.gen(function* () {
      const seen: Array<unknown> = [];
      const stub = yield* httpStub((req, res) => {
        const chunks: Array<Buffer> = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', () => {
          seen.push([
            req.method,
            req.url,
            req.headers['content-type'],
            req.headers['content-length'],
            Buffer.concat(chunks).toString(),
          ]);
          res.writeHead(201, { 'content-type': 'application/json', 'x-llama': 'yes' }).end('{"ok":true}');
        });
      });
      const client = yield* LlamaHttp;
      const reply = yield* client
        .execute(
          HttpClientRequest.post(`${stub.url}/completion?x=1`).pipe(
            HttpClientRequest.bodyText('{"prompt":"é"}', 'application/json'),
          ),
        )
        .pipe(
          Effect.flatMap((res) => Effect.map(res.json, (json) => [res.status, res.headers['x-llama'], json] as const)),
          Effect.scoped,
        );
      assert.deepStrictEqual(seen, [['POST', '/completion?x=1', 'application/json', '15', '{"prompt":"é"}']]);
      assert.deepStrictEqual(reply, [201, 'yes', { ok: true }]);
    }),
  );

  it.effect('an error status is a response, not a failure', () =>
    Effect.gen(function* () {
      const stub = yield* httpStub((req, res) => {
        res.writeHead(503, { 'content-type': 'text/plain' }).end(`${req.method} loading`);
      });
      const client = yield* LlamaHttp;
      const reply = yield* client.get(`${stub.url}/health`).pipe(
        Effect.flatMap((res) => Effect.map(res.text, (text) => [res.status, text] as const)),
        Effect.scoped,
      );
      assert.deepStrictEqual(reply, [503, 'GET loading']);
    }),
  );

  it.effect('the body is streamed as it arrives, and leaving it closes the connection', () =>
    Effect.gen(function* () {
      let more = () => {};
      const stub = yield* httpStub((_req, res) => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('one');
        more = () => res.write('two');
      });
      const client = yield* LlamaHttp;
      const firstTwo = yield* client.get(stub.url).pipe(
        Effect.flatMap((res) =>
          res.stream.pipe(
            Stream.map((chunk) => decoder.decode(chunk)),
            Stream.tap(() => Effect.sync(() => more())),
            Stream.take(2),
            Stream.runCollect,
          ),
        ),
        Effect.scoped,
      );
      assert.deepStrictEqual(firstTwo, ['one', 'two']);
      yield* until(() => stub.closes() === 1);
    }),
  );

  it.effect('nothing listening fails with a transport error', () =>
    Effect.gen(function* () {
      const port = yield* freePort;
      const client = yield* LlamaHttp;
      const error = yield* client.get(`http://127.0.0.1:${port}/health`).pipe(Effect.scoped, Effect.flip);
      assert.strictEqual(error.reason._tag, 'TransportError');
    }),
  );

  it.effect('a timeout before the answer ends the request and closes the connection', () =>
    Effect.gen(function* () {
      const stub = yield* httpStub(() => {});
      const client = yield* LlamaHttp;
      const answer = yield* client.get(stub.url).pipe(Effect.scoped, Effect.timeoutOption('50 millis'));
      assert.isTrue(Option.isNone(answer));
      yield* until(() => stub.closes() === 1);
    }),
  );

  it.effect('a connection cut during the body fails the stream', () =>
    Effect.gen(function* () {
      const stub = yield* httpStub((_req, res) => {
        res.writeHead(200).write('one');
        later(10, () => res.destroy());
      });
      const client = yield* LlamaHttp;
      const exit = yield* client.get(stub.url).pipe(
        Effect.flatMap((res) => res.text),
        Effect.scoped,
        Effect.exit,
      );
      assert.isTrue(Exit.isFailure(exit));
    }),
  );

  it.effect('stays direct when the environment sets a proxy', () =>
    Effect.gen(function* () {
      const proxy = yield* httpStub((_req, res) => {
        res.end('proxy');
      });
      const direct = yield* httpStub((_req, res) => {
        res.end('direct');
      });
      const client = yield* LlamaHttp;
      const texts = yield* Effect.gen(function* () {
        yield* proxiedEnvironment(proxy.url);
        // The proxy is live: Node's own `fetch` goes through it, even to loopback.
        const viaNode = yield* nodeFetchText(direct.url);
        const viaLlama = yield* client.get(direct.url).pipe(
          Effect.flatMap((res) => res.text),
          Effect.scoped,
        );
        return [viaNode, viaLlama];
      }).pipe(Effect.scoped);
      assert.deepStrictEqual(texts, ['proxy', 'direct']);
      assert.strictEqual(proxy.requests(), 1);
    }),
  );

  it.effect('a redirect is the response, not followed', () =>
    Effect.gen(function* () {
      let followed = 0;
      const stub = yield* httpStub((req, res) => {
        if (req.url === '/elsewhere') followed++;
        res.writeHead(302, { location: '/elsewhere' }).end();
      });
      const client = yield* LlamaHttp;
      const reply = yield* client.get(`${stub.url}/props`).pipe(
        Effect.map((res) => [res.status, res.headers.location] as const),
        Effect.scoped,
      );
      assert.deepStrictEqual(reply, [302, '/elsewhere']);
      assert.strictEqual(followed, 0);
    }),
  );

  it.effect(
    'a silence of 3 s before the headers and between two chunks does not end the request',
    () =>
      Effect.gen(function* () {
        const SILENCE = 3000;
        const stub = yield* httpStub((req, res) => {
          if (req.url === '/late-headers') {
            later(SILENCE, () => res.writeHead(200).end('late'));
            return;
          }
          res.writeHead(200).write('first ');
          later(SILENCE, () => res.end('second'));
        });
        const client = yield* LlamaHttp;
        const text = (path: string) =>
          client.get(`${stub.url}${path}`).pipe(
            Effect.flatMap((res) => res.text),
            Effect.scoped,
          );
        // Both at once: one silence before the headers, one between two chunks.
        const texts = yield* Effect.all([text('/late-headers'), text('/late-chunk')], { concurrency: 2 });
        assert.deepStrictEqual(texts, ['late', 'first second']);
      }),
    { timeout: 10_000 },
  );
});
