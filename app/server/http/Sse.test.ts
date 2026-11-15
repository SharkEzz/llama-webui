import { NodeHttpClient } from '@effect/platform-node';
import { assert, it } from '@effect/vitest';
import {
  type Cause,
  Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Queue,
  Ref,
  Schedule,
  Scope,
  String as Str,
  Stream,
} from 'effect';
import { HttpClient, HttpRouter, type HttpServer } from 'effect/http';
import { Shutdown } from '../runtime/Shutdown.ts';
import { ServerTest, ServerWithClient } from '../testing/http.ts';
import { serve } from './HttpLive.ts';
import { sseResponse } from './Sse.ts';

type Event = { readonly event?: string; readonly data: string };

/** `GET /events` (and the other `routes`) served as the app serves them, with `Shutdown` outermost as in `App`. */
const appWith = <E, R, E2, R2>(
  routes: Layer.Layer<never, E, R>,
  server: Layer.Layer<HttpClient.HttpClient | HttpServer.HttpServer, E2, R2>,
) =>
  Shutdown.layerRunner.pipe(
    Layer.provideMerge(serve(routes).pipe(Layer.provideMerge(server))),
    Layer.provideMerge(Shutdown.layer),
  );

const app = <E, R>(routes: Layer.Layer<never, E, R>) => appWith(routes, ServerTest);

/** Reads a response body as it comes: `until` waits for a piece of text, `done` for the end and the whole text. */
const read = Effect.fn('read')(function* (client: HttpClient.HttpClient) {
  const text = yield* Ref.make('');
  const res = yield* client.get('/events');
  const fiber = yield* res.stream.pipe(
    Stream.decodeText,
    Stream.runForEach((chunk) => Ref.update(text, (t) => t + chunk)),
    Effect.andThen(Ref.get(text)),
    Effect.forkScoped,
  );
  const until = (piece: string) =>
    Ref.get(text).pipe(Effect.repeat({ until: Str.includes(piece), schedule: Schedule.spaced('10 millis') }));
  return { res, fiber, until };
});

it.live('events arrive as they are produced, then the response ends', () =>
  Effect.gen(function* () {
    const events = yield* Queue.unbounded<Event, Cause.Done>();
    const ctx = yield* Layer.build(app(HttpRouter.add('GET', '/events', sseResponse(Stream.fromQueue(events)))));
    const reader = yield* read(Context.get(ctx, HttpClient.HttpClient));
    assert.strictEqual(reader.res.headers['content-type'], 'text/event-stream');
    assert.strictEqual(reader.res.headers['x-accel-buffering'], 'no');
    assert.strictEqual(reader.res.headers.connection, 'close');
    assert.match(reader.res.headers['cache-control'] ?? '', /no-cache/);
    yield* Queue.offer(events, { event: 'token', data: '1' });
    yield* reader.until('data: 1\n\n');
    yield* Queue.offer(events, { data: 'two\nlines' });
    yield* Queue.end(events);
    const text = yield* Fiber.join(reader.fiber);
    assert.strictEqual(text, 'event: token\ndata: 1\n\ndata: two\ndata: lines\n\n');
  }),
);

it.live('a ping comment is sent while no event comes', () =>
  Effect.gen(function* () {
    const events = yield* Queue.unbounded<Event, Cause.Done>();
    const ctx = yield* Layer.build(
      app(HttpRouter.add('GET', '/events', sseResponse(Stream.fromQueue(events), { pingInterval: '50 millis' }))),
    );
    const reader = yield* read(Context.get(ctx, HttpClient.HttpClient));
    yield* reader.until(': ping\n\n');
    yield* Queue.end(events);
    const text = yield* Fiber.join(reader.fiber);
    assert.match(text, /^(: ping\n\n)+$/);
  }),
);

it.live('a client that goes away interrupts the source', () =>
  Effect.gen(function* () {
    const events = yield* Queue.unbounded<Event, Cause.Done>();
    const ended = yield* Deferred.make<void>();
    const source = Stream.fromQueue(events).pipe(Stream.ensuring(Deferred.succeed(ended, undefined)));
    const ctx = yield* Layer.build(app(HttpRouter.add('GET', '/events', sseResponse(source))));
    const client = Context.get(ctx, HttpClient.HttpClient);
    const leaves = yield* Scope.make();
    const reader = yield* read(client).pipe(Scope.provide(leaves));
    yield* Queue.offer(events, { data: 'first' });
    yield* reader.until('data: first');
    // The client leaves: its request is aborted, the connection closed.
    yield* Scope.close(leaves, Exit.void);
    yield* Deferred.await(ended).pipe(Effect.timeout('2 seconds'));
  }),
);

it.live('a Shutdown.before step that ends the source lets the client read the last event and a clean end', () =>
  Effect.gen(function* () {
    const events = yield* Queue.unbounded<Event, Cause.Done>();
    const EndAtShutdown = Layer.effectDiscard(
      Effect.gen(function* () {
        const shutdown = yield* Shutdown;
        yield* shutdown.before(
          Queue.offer(events, { event: 'done', data: 'last' }).pipe(Effect.andThen(Queue.end(events))),
        );
      }),
    );
    // The client lives outside the app, as a browser does: stopping the app does not close it.
    const client = yield* Layer.build(NodeHttpClient.layerNodeHttp);
    const scope = yield* Scope.make();
    const ctx = yield* Layer.buildWithScope(
      appWith(
        Layer.merge(HttpRouter.add('GET', '/events', sseResponse(Stream.fromQueue(events))), EndAtShutdown),
        ServerWithClient.pipe(Layer.provide(Layer.succeedContext(client))),
      ),
      scope,
    );
    const reader = yield* read(Context.get(ctx, HttpClient.HttpClient));
    yield* Queue.offer(events, { data: 'first' });
    yield* reader.until('data: first');
    // The app stops while the client reads.
    const stopping = yield* Scope.close(scope, Exit.void).pipe(Effect.forkChild);
    const text = yield* Fiber.join(reader.fiber);
    assert.strictEqual(text, 'data: first\n\nevent: done\ndata: last\n\n');
    yield* Fiber.join(stopping);
  }),
);
