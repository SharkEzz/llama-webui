import { NodeSocketServer } from '@effect/platform-node';
import { Effect, Predicate, Schema } from 'effect';
import type { SocketServer } from 'effect/socket';
import { AppConfig } from '../config/AppConfig.ts';

/** Nothing can listen on the configured address: another process holds the port, or the system refuses it. */
export class AddressInUse extends Schema.TaggedError<AddressInUse, { readonly AddressInUse: unique symbol }>()(
  'AddressInUse',
  { message: Schema.String },
) {}

/** Why the system refused: the usual case in words, else the system's own message. */
const reason = (error: SocketServer.SocketServerError): string => {
  const cause = error.reason.cause;
  if (Predicate.hasProperty(cause, 'code') && cause.code === 'EADDRINUSE') return 'the port is already in use';
  return Predicate.hasProperty(cause, 'message') && Predicate.isString(cause.message) ? cause.message : String(cause);
};

/**
 * Fails when nothing can listen on the configured address. `message`: `cannot listen on <host>:<port>: the port is
 * already in use` (or the system's reason). Listens exclusively for a moment, then lets go: run it before anything
 * touches the data directory, so that a second instance leaves the data of the first alone.
 */
export const assertFree: Effect.Effect<void, AddressInUse, AppConfig> = Effect.gen(function* () {
  const { host, port } = yield* AppConfig;
  yield* NodeSocketServer.make({ host, port, exclusive: true }).pipe(
    Effect.scoped,
    Effect.mapError((error) => AddressInUse.make({ message: `cannot listen on ${host}:${port}: ${reason(error)}` })),
  );
}).pipe(Effect.withSpan('Address.assertFree'));
