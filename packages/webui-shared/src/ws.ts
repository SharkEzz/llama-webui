import { Schema } from 'effect';
import { LogLine } from './logs.ts';
import { Snapshot } from './monitor.ts';
import { ServerView } from './server.ts';
import { ModelPlacement } from './topology.ts';

/** Sent to each client as soon as it is attached: the server's clock and the id of this start. */
export const WsHello = Schema.Struct({
  type: Schema.Literal('hello'),
  payload: Schema.Struct({ serverTime: Schema.Int, bootId: Schema.String }),
});

/** Sent by the server every interval; sent by a client, answered with `pong`. */
export const WsPing = Schema.Struct({ type: Schema.Literal('ping') });

/** The answer to a `ping`; received from a client, it resets that client's missed pings. */
export const WsPong = Schema.Struct({ type: Schema.Literal('pong') });

/** The state of llama-server, sent on every change, in the order the changes happened. */
export const WsServerState = Schema.Struct({ type: Schema.Literal('server-state'), payload: ServerView });

/** The lines llama-server wrote since the last `log` message, in order. */
export const WsLog = Schema.Struct({ type: Schema.Literal('log'), payload: Schema.Array(LogLine) });

/** The monitoring state of a tick, sent on every tick. */
export const WsSnapshot = Schema.Struct({ type: Schema.Literal('snapshot'), payload: Snapshot });

/** Where the model is (devices, layers, bytes), sent when it changes; null when no model is placed. */
export const WsPlacement = Schema.Struct({ type: Schema.Literal('placement'), payload: Schema.NullOr(ModelPlacement) });

/** The messages of the /ws push channel, one member per message; each later milestone adds its own. */
export const WsMessage = Schema.Union([WsHello, WsPing, WsPong, WsServerState, WsLog, WsSnapshot, WsPlacement]);
export type WsMessage = typeof WsMessage.Type;
