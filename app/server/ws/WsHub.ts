import { WsMessage, WsPing, WsPong } from '@llama-webui/shared';
import { Clock, Context, type Duration, Effect, Layer, PubSub, Ref, Schedule, Schema, String as Str } from 'effect';
import { HttpRouter, HttpServerRequest, HttpServerResponse } from 'effect/http';
import { Socket } from 'effect/socket';
import { AppInfo } from '../config/AppInfo.ts';

/** Pings a client may leave unanswered: at the next tick it is closed with 4000 `heartbeat`. */
const MAX_MISSED = 2;

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
  /** The hub, pinging each client every `pingInterval`. */
  static readonly layerWith = (options: { readonly pingInterval: Duration.Input }) =>
    Layer.effect(
      WsHub,
      Effect.gen(function* () {
        const info = yield* AppInfo;
        const pubsub = yield* PubSub.unbounded<WsMessage>();
        const clients = yield* Ref.make(0);

        const attach = Effect.fn('WsHub.attach')(
          function* (socket: Socket.Socket) {
            // The handshake answer leaves when the reader is acquired: before the first write.
            const pull = yield* Socket.readerString(socket);
            const { write } = yield* socket.writer;
            // A write to a socket that just closed fails: the reader sees the close and ends the client.
            const send = (message: WsMessage) => encode(message).pipe(Effect.flatMap(write), Effect.ignore);
            const messages = yield* PubSub.subscribe(pubsub);
            yield* Effect.acquireRelease(
              Ref.update(clients, (n) => n + 1),
              () => Ref.update(clients, (n) => n - 1),
            );

            const serverTime = yield* Clock.currentTimeMillis;
            yield* send({ type: 'hello', payload: { serverTime, bootId: info.bootId } });

            yield* PubSub.take(messages).pipe(Effect.flatMap(send), Effect.forever, Effect.forkScoped);

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
          size: Ref.get(clients),
          attach,
        };
      }),
    );

  /** The hub, pinging each client every 15 s. */
  static readonly layer: Layer.Layer<WsHub, never, AppInfo> = WsHub.layerWith({ pingInterval: '15 seconds' });

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
