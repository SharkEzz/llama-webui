import { assert, it } from '@effect/vitest';
import { WsHello, WsMessage } from '@llama-webui/shared';
import {
  Array as Arr,
  Clock,
  Context,
  Deferred,
  type Duration,
  Effect,
  Exit,
  Fiber,
  Layer,
  Logger,
  Metric,
  Ref,
  Schedule,
  Schema,
  Scope,
  String as Str,
} from 'effect';
import { HttpClient, HttpClientRequest, HttpServer } from 'effect/http';
import { Socket } from 'effect/socket';
import { TestClock } from 'effect/testing';
import { AppInfo } from '../config/AppInfo.ts';
import { serve } from '../http/HttpLive.ts';
import { WsMetrics } from '../runtime/Metrics.ts';
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
  options: {
    readonly ping?: Duration.Input;
    readonly scope?: Scope.Scope;
    readonly atShutdown?: ReadonlyArray<WsMessage>;
  } = {},
) {
  const { ping = '1 minute', scope, atShutdown = [] } = options;
  // A step that publishes `atShutdown`, in order, when the app stops.
  const step = Layer.effectDiscard(
    Effect.gen(function* () {
      const shutdown = yield* Shutdown;
      const hub = yield* WsHub;
      yield* shutdown.before(Effect.forEach(atShutdown, hub.publish, { discard: true }));
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

it.live('the clients are counted while they are connected, and the messages they are sent', () =>
  Effect.gen(function* () {
    const { open, hub } = yield* start();
    const a = yield* open();
    const b = yield* open();
    yield* sizeIs(hub, 2);
    assert.strictEqual((yield* Metric.value(WsMetrics.clients)).value, 2);
    yield* hub.publish({ type: 'ping' });
    yield* next(a, 'ping');
    yield* next(b, 'ping');
    // A hello and a ping to each: counted once written, so maybe just after the client read it.
    const sent = yield* Metric.value(WsMetrics.sent).pipe(
      Effect.repeat({ until: (state) => state.count >= 4, schedule: Schedule.spaced('10 millis') }),
      Effect.timeout('2 seconds'),
    );
    assert.strictEqual(sent.count, 4);
    assert.isAbove((yield* Metric.value(WsMetrics.sentBytes)).count, 0);
    assert.strictEqual((yield* Metric.value(WsMetrics.published)).occurrences.get('ping'), 1);
    a.socket.close();
    yield* sizeIs(hub, 1);
    assert.strictEqual((yield* Metric.value(WsMetrics.clients)).value, 1);
  }).pipe(Effect.provideService(Metric.MetricRegistry, new Map())),
);

it.live('a message that does not encode is logged with its type, not sent, and the next one arrives', () => {
  const errors: Array<ReadonlyArray<unknown>> = [];
  const logger = Logger.make<unknown, void>(({ logLevel, message }) => {
    if (logLevel === 'Error') errors.push(Arr.ensure(message));
  });
  return Effect.gen(function* () {
    const app = yield* start();
    const a = yield* app.open();
    yield* next(a, 'hello');
    // An id that is no integer: the type allows it, the schema does not.
    yield* app.hub.publish({ type: 'download-deleted', payload: { ids: [Number.NaN] } });
    yield* app.hub.publish({ type: 'download-deleted', payload: { ids: [7] } });
    const got = yield* next(a, 'download-deleted');
    assert.deepStrictEqual(got, { type: 'download-deleted', payload: { ids: [7] } });
    const [logged] = errors;
    assert.strictEqual(errors.length, 1);
    assert.strictEqual(logged?.[0], 'a download-deleted message does not encode: not sent');
  }).pipe(Effect.provideService(Logger.CurrentLoggers, new Set([logger])));
});

it.live('a published message is encoded once for every client: one that does not encode is logged once', () => {
  const errors: Array<ReadonlyArray<unknown>> = [];
  const logger = Logger.make<unknown, void>(({ logLevel, message }) => {
    if (logLevel === 'Error') errors.push(Arr.ensure(message));
  });
  return Effect.gen(function* () {
    const app = yield* start();
    const clients = yield* Effect.forEach(Arr.range(1, 3), () => app.open());
    yield* sizeIs(app.hub, 3);
    yield* app.hub.publish({ type: 'download-deleted', payload: { ids: [Number.NaN] } });
    yield* app.hub.publish({ type: 'download-deleted', payload: { ids: [7] } });
    for (const client of clients) {
      const got = yield* next(client, 'download-deleted');
      assert.deepStrictEqual(got, { type: 'download-deleted', payload: { ids: [7] } });
    }
    assert.strictEqual(errors.length, 1);
  }).pipe(Effect.provideService(Logger.CurrentLoggers, new Set([logger])));
});

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

it.live('text that is not a JSON object is ignored (#37)', () =>
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

it.live('a binary frame is read as UTF-8 text', () =>
  Effect.gen(function* () {
    const { open } = yield* start();
    const client = yield* open();
    yield* next(client, 'hello');
    client.socket.send(new TextEncoder().encode('{"type":"ping"}'));
    yield* next(client, 'pong');
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
    const { open, hub } = yield* start({ scope, atShutdown: [{ type: 'pong' }] });
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

/** The messages and the close of `client`, in the order they arrive, from now on. */
const recorded = (client: WsClient) => {
  const order: Array<string> = [];
  client.socket.addEventListener('message', (event) => order.push(String(event.data)));
  client.socket.addEventListener('close', (event) => order.push(`close ${event.code}`));
  return order;
};

it.live('a shutdown step that publishes many messages: every client gets them all, then its 1001', () =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const many = Arr.makeBy(200, (i): WsMessage => ({ type: 'hello', payload: { serverTime: i, bootId: 'step' } }));
    const { open, hub } = yield* start({ scope, atShutdown: many });
    const a = yield* open();
    const b = yield* open();
    yield* next(a, 'hello');
    yield* next(b, 'hello');
    yield* sizeIs(hub, 2);
    const orders = [recorded(a), recorded(b)];
    yield* Scope.close(scope, Exit.void);
    yield* Effect.promise(() => Promise.all([a.closed, b.closed])).pipe(Effect.timeout('2 seconds'));
    const encode = Schema.encodeEffect(Schema.fromJsonString(WsMessage));
    const texts = yield* Effect.forEach(many, (message) => encode(message));
    const expected = [...texts, 'close 1001'];
    for (const order of orders) assert.deepStrictEqual(order, expected);
  }),
);

it.effect('a client that does not read does not hold the stop past the timeout', () =>
  Effect.gen(function* () {
    const ctx = yield* Layer.build(
      WsHub.layerWith({ pingInterval: '1 minute' }).pipe(
        Layer.provideMerge(AppInfo.layer),
        Layer.provideMerge(Shutdown.layer),
      ),
    );
    const hub = Context.get(ctx, WsHub);
    const shutdown = Context.get(ctx, Shutdown);
    // A client whose writes block once it got its hello, as a socket that waits for the peer to read would.
    const greeted = yield* Deferred.make<void>();
    const stuck = Socket.make({
      reader: Effect.succeed({ pull: Effect.never, upgrade: () => Effect.void }),
      writer: Effect.succeed({
        write: () =>
          Deferred.succeed(greeted, undefined).pipe(Effect.flatMap((first) => (first ? Effect.void : Effect.never))),
        writeAll: () => Effect.never,
      }),
    });
    yield* hub.attach(stuck).pipe(Effect.forkChild);
    yield* Deferred.await(greeted);
    yield* shutdown.before(hub.publish({ type: 'ping' }));

    const startedAt = yield* Clock.currentTimeMillis;
    const stopping = yield* shutdown.run.pipe(Effect.forkChild);
    // The test clock moves 10 ms at a time until the stop ends: it cannot end before the 500 ms of the timeout.
    for (let i = 0; i < 100 && stopping.pollUnsafe() === undefined; i++) yield* TestClock.adjust('10 millis');
    assert.isDefined(stopping.pollUnsafe(), 'the stop still waits after 1 s');
    const elapsed = (yield* Clock.currentTimeMillis) - startedAt;
    assert.isAtLeast(elapsed, 500);
    assert.isBelow(elapsed, 600);
  }),
);

/** A `snapshot` message of tick `tick` (taken `at`), every other field empty. */
const snapshot = (tick: number, at: number = 1_700_000_000_000 + tick * 1000): WsMessage => ({
  type: 'snapshot',
  payload: {
    at,
    tick,
    health: null,
    rates: { genTps: 0, ppTps: 0 },
    slots: null,
    kv: null,
    queue: null,
    lastRequest: null,
    spec: null,
    recentRequests: [],
    gpus: [],
    allGpus: [],
    proc: null,
    system: null,
    disk: null,
    points: {},
    history: { intervalMs: 1000, capacity: 300 },
  },
});

/** The `type` of a message, and its tick for a snapshot. */
const label = (message: unknown) => {
  const { type, payload } = message as { type: string; payload?: { tick?: number } };
  return type === 'snapshot' ? `snapshot ${payload?.tick}` : type;
};

/** Every message `client` got until a `pong` published once it is counted: what it was sent on connection. */
const greeting = Effect.fnUntraced(function* (hub: WsHub['Service'], client: WsClient) {
  yield* sizeIs(hub, 1);
  yield* hub.publish({ type: 'pong' });
  yield* next(client, 'pong');
  return Arr.map(client.messages.slice(0, -1), label);
});

it.live('a client that connects after a snapshot gets hello, then that snapshot', () =>
  Effect.gen(function* () {
    const { open, hub } = yield* start();
    yield* hub.publish(snapshot(1));
    const client = yield* open();
    const got = yield* greeting(hub, client);
    assert.deepStrictEqual(got, ['hello', 'snapshot 1']);
    assert.deepStrictEqual(client.messages[1], snapshot(1));
  }),
);

it.live('a snapshot published while a client is connected is sent as is to one that connects later', () =>
  Effect.gen(function* () {
    const { open, hub } = yield* start();
    const first = yield* open();
    yield* sizeIs(hub, 1);
    yield* hub.publish(snapshot(1));
    const sent = yield* next(first, 'snapshot');
    assert.deepStrictEqual(sent, snapshot(1));
    first.socket.close();
    yield* sizeIs(hub, 0);
    const client = yield* open();
    const got = yield* greeting(hub, client);
    assert.deepStrictEqual(got, ['hello', 'snapshot 1']);
    assert.deepStrictEqual(client.messages[1], snapshot(1));
  }),
);

it.live('a snapshot that does not encode is not kept: a client that connects gets the one before it', () =>
  Effect.gen(function* () {
    const { open, hub } = yield* start();
    const first = yield* open();
    yield* sizeIs(hub, 1);
    yield* hub.publish(snapshot(1));
    // A time that is no integer: the type allows it, the schema does not.
    yield* hub.publish(snapshot(2, Number.NaN));
    yield* next(first, 'snapshot');
    first.socket.close();
    yield* sizeIs(hub, 0);
    const client = yield* open();
    const got = yield* greeting(hub, client);
    assert.deepStrictEqual(got, ['hello', 'snapshot 1']);
  }).pipe(Effect.provideService(Logger.CurrentLoggers, new Set())),
);

it.live('a client that connects before any snapshot gets only hello', () =>
  Effect.gen(function* () {
    const { open, hub } = yield* start();
    const client = yield* open();
    const got = yield* greeting(hub, client);
    assert.deepStrictEqual(got, ['hello']);
  }),
);

it.live('a client that connects gets only the latest snapshot', () =>
  Effect.gen(function* () {
    const { open, hub } = yield* start();
    yield* hub.publish(snapshot(1));
    yield* hub.publish(snapshot(2));
    const client = yield* open();
    const got = yield* greeting(hub, client);
    assert.deepStrictEqual(got, ['hello', 'snapshot 2']);
  }),
);

it.live('only the snapshot is sent again to a client that connects, not the other messages', () =>
  Effect.gen(function* () {
    const { open, hub } = yield* start();
    yield* hub.publish(snapshot(1));
    yield* hub.publish({ type: 'download-deleted', payload: { ids: [7] } });
    yield* hub.publish({ type: 'placement', payload: null });
    yield* hub.publish({ type: 'ping' });
    const client = yield* open();
    const got = yield* greeting(hub, client);
    assert.deepStrictEqual(got, ['hello', 'snapshot 1']);
  }),
);

it.live('a client that connects while snapshots are published gets each one once, in order', () =>
  Effect.gen(function* () {
    const { open, hub } = yield* start();
    // A tick every millisecond while the clients connect: some land around a subscription and its greeting.
    const last = yield* Ref.make(0);
    const ticking = yield* Ref.updateAndGet(last, (n) => n + 1).pipe(
      Effect.flatMap((tick) => hub.publish(snapshot(tick))),
      Effect.andThen(Effect.sleep('1 millis')),
      Effect.forever,
      Effect.forkChild,
    );
    const clients = yield* Effect.forEach(Arr.range(1, 8), () => open(), { concurrency: 'unbounded' });
    yield* sizeIs(hub, clients.length);
    yield* Effect.sleep('20 millis');
    yield* Fiber.interrupt(ticking);
    const final = yield* Ref.get(last);
    yield* hub.publish({ type: 'pong' });
    for (const client of clients) {
      yield* next(client, 'pong');
      const [hello, ...rest] = Arr.map(client.messages.slice(0, -1), label);
      assert.strictEqual(hello, 'hello');
      const ticks = Arr.map(rest, (text) => Number(Str.split(' ')(text)[1]));
      const first = ticks[0] ?? 0;
      assert.deepStrictEqual(ticks, Arr.range(first, final));
    }
  }),
);
