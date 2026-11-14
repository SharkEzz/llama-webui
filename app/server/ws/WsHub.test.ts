import { assert, it } from '@effect/vitest';
import { WsHello, type WsMessage } from '@llama-webui/shared';
import {
  Clock,
  Context,
  type Duration,
  Effect,
  Exit,
  Fiber,
  Layer,
  Schedule,
  Schema,
  Scope,
  String as Str,
} from 'effect';
import { HttpClient, HttpClientRequest, HttpServer } from 'effect/http';
import { AppInfo } from '../config/AppInfo.ts';
import { serve } from '../http/HttpLive.ts';
import { Shutdown } from '../runtime/Shutdown.ts';
import { ServerTest } from '../testing/http.ts';
import { ofType, openWs, type WsClient } from '../testing/ws.ts';
import { WsHub } from './WsHub.ts';

/** `/ws` served as the app serves it (behind the guard, `Shutdown` outermost), on a hub that pings every `ping`. */
const appWith = <E, R>(ping: Duration.Input, extra: Layer.Layer<never, E, R>) =>
  Shutdown.layerRunner.pipe(
    Layer.provideMerge(serve(Layer.merge(WsHub.route, extra)).pipe(Layer.provideMerge(ServerTest))),
    Layer.provideMerge(WsHub.layerWith({ pingInterval: ping })),
    Layer.provideMerge(AppInfo.layer),
    Layer.provideMerge(Shutdown.layer),
  );

/** The app, its hub, and how to open a client on its `/ws`; stopped with the test's scope. */
const start = Effect.fn('start')(function* (
  options: { readonly ping?: Duration.Input; readonly scope?: Scope.Scope; readonly atShutdown?: WsMessage } = {},
) {
  const { ping = '1 minute', scope, atShutdown } = options;
  // A step that publishes `atShutdown` when the app stops.
  const step = Layer.effectDiscard(
    Effect.gen(function* () {
      const shutdown = yield* Shutdown;
      const hub = yield* WsHub;
      if (atShutdown !== undefined) yield* shutdown.before(hub.publish(atShutdown));
    }),
  );
  const app = appWith(ping, step);
  const ctx = yield* scope === undefined ? Layer.build(app) : Layer.buildWithScope(app, scope);
  // `http://127.0.0.1:<port>`
  const base = HttpServer.formatAddress(Context.get(ctx, HttpServer.HttpServer).address);
  const url = `${Str.replace('http', 'ws')(base)}/ws`;
  return {
    hub: Context.get(ctx, WsHub),
    info: Context.get(ctx, AppInfo),
    client: Context.get(ctx, HttpClient.HttpClient),
    open: (headers?: Record<string, string>) =>
      Effect.acquireRelease(
        Effect.promise(() => openWs(url, headers)),
        (client) => Effect.sync(() => client.socket.close()),
      ),
  };
});

const next = (client: WsClient, type?: string, ms?: number) =>
  Effect.promise(() => client.next(type === undefined ? undefined : ofType(type), ms));

/** Waits until the hub counts `n` clients. */
const sizeIs = (hub: WsHub['Service'], n: number) =>
  hub.size.pipe(
    Effect.repeat({ until: (size) => size === n, schedule: Schedule.spaced('10 millis') }),
    Effect.timeout('2 seconds'),
  );

it.live('a client gets hello with the server time and the bootId', () =>
  Effect.gen(function* () {
    const before = yield* Clock.currentTimeMillis;
    const { open, info } = yield* start();
    const client = yield* open();
    const first = yield* next(client);
    const hello = yield* Schema.decodeUnknownEffect(WsHello)(first);
    const after = yield* Clock.currentTimeMillis;
    assert.strictEqual(hello.payload.bootId, info.bootId);
    assert.isAtLeast(hello.payload.serverTime, before);
    assert.isAtMost(hello.payload.serverTime, after);
  }),
);

it.live('a published message reaches every client', () =>
  Effect.gen(function* () {
    const { open, hub } = yield* start();
    const a = yield* open();
    const b = yield* open();
    yield* sizeIs(hub, 2);
    yield* hub.publish({ type: 'ping' });
    yield* next(a, 'ping');
    yield* next(b, 'ping');
    const size = yield* hub.size;
    assert.strictEqual(size, 2);
  }),
);

it.live('a client ping is answered with pong', () =>
  Effect.gen(function* () {
    const { open } = yield* start();
    const client = yield* open();
    yield* next(client, 'hello');
    client.send({ type: 'ping' });
    yield* next(client, 'pong');
  }),
);

it.live('a client that misses 2 pings is closed with 4000, a pong keeps it', () =>
  Effect.gen(function* () {
    const { open, hub } = yield* start({ ping: '50 millis' });
    const silent = yield* open();
    const alive = yield* open();
    alive.onMessage((message) => {
      if (ofType('ping')(message)) alive.send({ type: 'pong' });
    });
    const closed = yield* Effect.promise(() => silent.closed).pipe(Effect.timeout('2 seconds'));
    assert.strictEqual(closed.code, 4000);
    // The one that answers lives on, ping after ping.
    yield* Effect.sleep('300 millis');
    assert.strictEqual(alive.socket.readyState, WebSocket.OPEN);
    yield* sizeIs(hub, 1);
  }),
);

it.live('text that is not a JSON object is ignored', () =>
  Effect.gen(function* () {
    const { open } = yield* start();
    const client = yield* open();
    yield* next(client, 'hello');
    for (const text of ['null', '3', '[]', '{', '"ping"', '{"type":"nope"}']) client.send(text);
    client.send({ type: 'ping' });
    yield* next(client, 'pong');
    assert.strictEqual(client.socket.readyState, WebSocket.OPEN);
  }),
);

it.live('a message over 4096 bytes closes the connection with 1009', () =>
  Effect.gen(function* () {
    const { open } = yield* start();
    const client = yield* open();
    client.send({ type: 'ping', pad: Str.repeat(4096)('x') });
    const closed = yield* Effect.promise(() => client.closed).pipe(Effect.timeout('2 seconds'));
    assert.strictEqual(closed.code, 1009);
  }),
);

it.live('the upgrade goes through the guard', () =>
  Effect.gen(function* () {
    const { open, hub } = yield* start();
    const refused = yield* open({ origin: 'https://evil.example' }).pipe(Effect.exit);
    assert.isTrue(Exit.isFailure(refused));
    const size = yield* hub.size;
    assert.strictEqual(size, 0);
  }),
);

it.live('/ws without an upgrade is a 426', () =>
  Effect.gen(function* () {
    const { client } = yield* start();
    for (const request of [HttpClientRequest.get('/ws'), HttpClientRequest.post('/ws')]) {
      const res = yield* client.execute(request);
      const text = yield* res.text;
      assert.strictEqual(res.status, 426, request.method);
      assert.strictEqual(res.headers['content-type'], 'text/plain;charset=utf-8');
      assert.strictEqual(text, 'WebSocket upgrade expected');
    }
  }),
);

it.live('closing the app sends 1001 after the Shutdown.before steps', () =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const { open, hub } = yield* start({ scope, atShutdown: { type: 'pong' } });
    const client = yield* open();
    yield* next(client, 'hello');
    yield* sizeIs(hub, 1);
    const order: Array<string> = [];
    client.socket.addEventListener('message', (event) => order.push(String(event.data)));
    client.socket.addEventListener('close', (event) => order.push(`close ${event.code}`));
    const stopping = yield* Scope.close(scope, Exit.void).pipe(Effect.forkChild);
    yield* Fiber.join(stopping);
    yield* Effect.promise(() => client.closed).pipe(Effect.timeout('2 seconds'));
    assert.deepStrictEqual(order, ['{"type":"pong"}', 'close 1001']);
  }),
);
