import { WsMessage, WsPing, WsPong } from '@llama-webui/shared';
import {
  Clock,
  Context,
  Deferred,
  type Duration,
  Effect,
  Layer,
  PubSub,
  Ref,
  Schedule,
  Schema,
  String as Str,
} from 'effect';
import { HttpRouter, HttpServerRequest, HttpServerResponse } from 'effect/http';
import { Socket } from 'effect/socket';
import { AppInfo } from '../config/AppInfo.ts';
import { Shutdown } from '../runtime/Shutdown.ts';

/** Pings a client may leave unanswered: at the next tick it is closed with 4000 `heartbeat`. */
const MAX_MISSED = 2;

/** How long the stop waits for the clients to be sent what the shutdown steps published. */
const FLUSH_TIMEOUT = '500 millis';

/** Published after the shutdown steps: a client that takes it has been sent every message published before it. */
const Flush: unique symbol = Symbol('WsHub.Flush');

const encode = Schema.encodeEffect(Schema.fromJsonString(WsMessage));

/** What a client may send: anything else, JSON or not, is ignored. */
const decodeClient = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Union([WsPing, WsPong])));

/** The push channel of `/ws`: every connected client gets each published message. */
export class WsHub extends Context.Service<
  WsHub,
  {
    /** Sends a message to every connected client. */
    readonly publish: (message: WsMessage) => Effect.Effect<void>;
    /** The number of connected clients. */
    readonly size: Effect.Effect<number>;
    /** The life of one client on its upgraded socket, until it closes: what the `/ws` route runs. */
    readonly attach: (socket: Socket.Socket) => Effect.Effect<void>;
  }
>()('@llama-webui/app/server/ws/WsHub') {
  /**
   * The hub, pinging each client every `pingInterval`. Its own shutdown step, registered when it is built (so it runs
   * after the steps of the services built on it), waits until each client has been sent every message published so
   * far, at most 500 ms: the HTTP server's 1001 then comes after them.
   */
  static readonly layerWith = (options: { readonly pingInterval: Duration.Input }) =>
    Layer.effect(
      WsHub,
      Effect.gen(function* () {
        const info = yield* AppInfo;
        const shutdown = yield* Shutdown;
        const pubsub = yield* PubSub.unbounded<WsMessage | typeof Flush>();
        // One Deferred per connected client, completed once it took `Flush` (or left). A native set: Effect's
        // `HashSet` compares structurally, and two pending Deferreds are equal there.
        const clients = yield* Ref.make<ReadonlySet<Deferred.Deferred<void>>>(new Set());

        yield* shutdown.before(
          Effect.gen(function* () {
            const waiting = yield* Ref.get(clients);
            yield* PubSub.publish(pubsub, Flush);
            // A finalizer runs uninterruptibly: the wait is made interruptible for the timeout to end it.
            yield* Effect.forEach(waiting, Deferred.await, { concurrency: 'unbounded', discard: true }).pipe(
              Effect.interruptible,
              Effect.timeout(FLUSH_TIMEOUT),
              Effect.ignore,
            );
          }).pipe(Effect.withSpan('WsHub.flush')),
        );

        const attach = Effect.fn('WsHub.attach')(
          function* (socket: Socket.Socket) {
            // The handshake answer leaves when the reader is acquired: before the first write.
            const pull = yield* Socket.readerString(socket);
            const { write } = yield* socket.writer;
            // A write to a socket that just closed fails: the reader sees the close and ends the client.
            const send = (message: WsMessage) => encode(message).pipe(Effect.flatMap(write), Effect.ignore);
            // Subscribed before it is counted: a flush that waits for this client finds `Flush` in its queue.
            const messages = yield* PubSub.subscribe(pubsub);
            const flushed = yield* Deferred.make<void>();
            yield* Effect.acquireRelease(
              Ref.update(clients, (set) => new Set(set).add(flushed)),
              () =>
                Ref.update(clients, (set) => {
                  const rest = new Set(set);
                  rest.delete(flushed);
                  return rest;
                }).pipe(Effect.andThen(Deferred.succeed(flushed, undefined))),
            );

            const serverTime = yield* Clock.currentTimeMillis;
            yield* send({ type: 'hello', payload: { serverTime, bootId: info.bootId } });

            yield* PubSub.take(messages).pipe(
              Effect.flatMap((item) => (item === Flush ? Deferred.succeed(flushed, undefined) : send(item))),
              Effect.forever,
              Effect.forkScoped,
            );

            const missed = yield* Ref.make(0);
            const tick = Effect.gen(function* () {
              const unanswered = yield* Ref.getAndUpdate(missed, (n) => n + 1);
              if (unanswered < MAX_MISSED) return yield* send({ type: 'ping' });
              yield* write(new Socket.CloseEvent(4000, 'heartbeat')).pipe(Effect.ignore);
            });
            yield* tick.pipe(
              Effect.delay(options.pingInterval),
              Effect.repeat(Schedule.spaced(options.pingInterval)),
              Effect.forkScoped,
            );

            const receive = (text: string) =>
              decodeClient(text).pipe(
                Effect.flatMap((message) => (message.type === 'ping' ? send({ type: 'pong' }) : Ref.set(missed, 0))),
                Effect.ignore,
              );
            // Until the client closes (or is closed): `pull` then fails.
            return yield* pull.pipe(
              Effect.flatMap((frames) => Effect.forEach(frames, receive, { discard: true })),
              Effect.forever,
            );
          },
          Effect.scoped,
          Effect.catchTag('SocketError', () => Effect.void),
        );

        return {
          publish: (message) => PubSub.publish(pubsub, message).pipe(Effect.asVoid),
          size: Ref.get(clients).pipe(Effect.map((set) => set.size)),
          attach,
        };
      }),
    );

  /** The hub, pinging each client every 15 s. */
  static readonly layer: Layer.Layer<WsHub, never, AppInfo | Shutdown> = WsHub.layerWith({
    pingInterval: '15 seconds',
  });

  /** `GET /ws`: the upgrade, then one fiber per client. Any request without an upgrade is a 426. */
  static readonly route = HttpRouter.add(
    '*',
    '/ws',
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      if (Str.toLowerCase(request.headers.upgrade ?? '') !== 'websocket')
        return HttpServerResponse.text('WebSocket upgrade expected', {
          status: 426,
          contentType: 'text/plain;charset=utf-8',
        });
      const hub = yield* WsHub;
      const socket = yield* request.upgrade.pipe(Effect.orDie);
      yield* hub.attach(socket);
      return HttpServerResponse.empty();
    }),
  );
}
