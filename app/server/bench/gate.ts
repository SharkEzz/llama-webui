import { ExternalServerRunning, ServerRunning, ServerStopTooSlow } from '@llama-webui/shared';
import {
  Cause,
  Deferred,
  type Duration,
  Effect,
  Exit,
  Fiber,
  Option,
  Predicate,
  Ref,
  Schedule,
  Schema,
  Scope,
} from 'effect';
import { LogRing } from '../logs/LogRing.ts';
import type { BuiltCommand } from '../supervisor/command.ts';
import { Supervisor } from '../supervisor/Supervisor.ts';

/** The stop of llama-server the gate started did not end well: its message. Internal, not on the wire. */
export class StopFailed extends Schema.TaggedError<StopFailed, { readonly StopFailed: unique symbol }>()('StopFailed', {
  message: Schema.String,
}) {}

/** llama-server did not come back after the benchmark: `could not restart llama-server: <msg>`. Internal. */
export class RestartFailed extends Schema.TaggedError<RestartFailed, { readonly RestartFailed: unique symbol }>()(
  'RestartFailed',
  { message: Schema.String },
) {}

/** The managed llama-server during benchmarks: stopped once when the gate is taken, restarted once when it is released. */
export interface Gate {
  readonly held: Effect.Effect<boolean>;
  /** The command of the server the gate stopped, to restart; none when it stopped none. */
  readonly stoppedCommand: Effect.Effect<Option.Option<BuiltCommand>>;
  /**
   * Takes the gate. Refused if an external server is running, or the managed one runs without `stopServer`. A stop
   * already in progress is awaited (up to `stoppingTimeout`; nothing to restart afterwards). With `stopServer`, the
   * stop of a running server is forked, not awaited: `ready` waits for it.
   */
  readonly acquire: (options: {
    readonly stopServer: boolean;
  }) => Effect.Effect<void, ServerStopTooSlow | ExternalServerRunning | ServerRunning>;
  /** Waits for the stop `acquire` started, if any. */
  readonly ready: Effect.Effect<void, StopFailed>;
  /**
   * Restarts the stopped server with the command `rebuild` gives (the profile as it is now, #39) or, when it gives
   * none, the recorded one, then frees the gate (also when the restart fails). Without the gate held: nothing. Two
   * releases at once are one.
   */
  readonly release: (
    rebuild: (stopped: BuiltCommand) => Effect.Effect<Option.Option<BuiltCommand>>,
  ) => Effect.Effect<void, RestartFailed>;
}

interface State {
  readonly held: boolean;
  readonly stopped: Option.Option<BuiltCommand>;
  readonly stopping: Option.Option<Fiber.Fiber<void>>;
  readonly releasing: Option.Option<Deferred.Deferred<void, RestartFailed>>;
}

const FREE: State = { held: false, stopped: Option.none(), stopping: Option.none(), releasing: Option.none() };

/** The message of what ended a fiber badly. */
const messageOf = (cause: Cause.Cause<unknown>): string => {
  const error = Cause.squash(cause);
  return Predicate.isError(error) ? error.message : String(error);
};

/**
 * The gate, on the supervisor: a stop in progress is looked at every `poll` (100 ms) for `stoppingTimeout`; the stop
 * it starts runs in the caller's scope (the runner's), not in a request's.
 */
export const makeGate = Effect.fn('makeGate')(function* (options: {
  readonly stoppingTimeout: Duration.Input;
  readonly poll?: Duration.Input;
}) {
  const supervisor = yield* Supervisor;
  const ring = yield* LogRing;
  const scope = yield* Scope.Scope;
  const state = yield* Ref.make<State>(FREE);

  const held = Effect.map(Ref.get(state), (s) => s.held);
  const stoppedCommand = Effect.map(Ref.get(state), (s) => s.stopped);

  const acquire = Effect.fn('Gate.acquire')(function* (request: { readonly stopServer: boolean }) {
    const now = yield* supervisor.state.pipe(
      Effect.repeat({
        schedule: Schedule.spaced(options.poll ?? '100 millis'),
        until: (s) => s.kind !== 'stopping',
      }),
      Effect.timeoutOrElse({
        duration: options.stoppingTimeout,
        orElse: () =>
          Effect.fail(ServerStopTooSlow.make({ message: 'llama-server is taking too long to stop: try again' })),
      }),
    );
    if (now.kind === 'external')
      return yield* ExternalServerRunning.make({
        message: `An external llama-server is running on port ${now.port}: stop it first`,
      });
    if (now.kind !== 'starting' && now.kind !== 'ready') return yield* Ref.set(state, { ...FREE, held: true });
    if (!request.stopServer)
      return yield* ServerRunning.make({
        message: `llama-server is running (profile ${now.profile}): it will be stopped during the benchmark, then restarted`,
      });
    const last = yield* supervisor.lastCommand;
    yield* ring.push('[bench] stopping llama-server for the benchmark');
    // Forked and recorded at once: an interruption in between would lose the stop to wait for.
    yield* Effect.uninterruptible(
      Effect.gen(function* () {
        const stopping = yield* Effect.forkIn(supervisor.stop, scope);
        yield* Ref.set(state, { ...FREE, held: true, stopped: last, stopping: Option.some(stopping) });
      }),
    );
  });

  const ready = Effect.gen(function* () {
    const { stopping } = yield* Ref.get(state);
    if (Option.isNone(stopping)) return;
    const ended = yield* Fiber.await(stopping.value);
    if (Exit.isSuccess(ended)) return;
    // Not stopped: nothing to restart.
    yield* Ref.update(state, (s) => ({ ...s, stopped: Option.none() }));
    return yield* StopFailed.make({ message: messageOf(ended.cause) });
  }).pipe(Effect.withSpan('Gate.ready'));

  /** The restart of what the gate stopped, if anything; the gate is freed by the caller. */
  const restart = Effect.fn('Gate.restart')(function* (
    rebuild: (stopped: BuiltCommand) => Effect.Effect<Option.Option<BuiltCommand>>,
  ) {
    const { stopping } = yield* Ref.get(state);
    if (Option.isSome(stopping)) yield* Fiber.await(stopping.value);
    const { stopped } = yield* Ref.get(state);
    if (Option.isNone(stopped)) return;
    const rebuilt = yield* rebuild(stopped.value);
    const cmd = Option.getOrElse(rebuilt, () => stopped.value);
    yield* ring.push(`[bench] restarting llama-server (${cmd.profileName})`);
    yield* supervisor.start(cmd).pipe(
      Effect.catch((error) => {
        const message = `could not restart llama-server: ${error.message}`;
        return ring.push(`[bench] ${message}`).pipe(Effect.andThen(Effect.fail(RestartFailed.make({ message }))));
      }),
    );
  });

  const release = Effect.fn('Gate.release')(function* (
    rebuild: (stopped: BuiltCommand) => Effect.Effect<Option.Option<BuiltCommand>>,
  ) {
    const mine = yield* Deferred.make<void, RestartFailed>();
    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const taken = yield* Ref.modify(state, (s): [Option.Option<Deferred.Deferred<void, RestartFailed>>, State] => {
          if (!s.held) return [Option.none(), s];
          if (Option.isSome(s.releasing)) return [s.releasing, s];
          return [Option.some(mine), { ...s, releasing: Option.some(mine) }];
        });
        if (Option.isNone(taken)) return;
        if (taken.value !== mine) return yield* restore(Deferred.await(taken.value));
        // Freed however the restart ends, an interruption included; a second release waiting gets the same end.
        return yield* restore(restart(rebuild)).pipe(
          Effect.onExit((ended) => Ref.set(state, FREE).pipe(Effect.andThen(Deferred.done(mine, ended)))),
        );
      }),
    );
  });

  const gate: Gate = { held, stoppedCommand, acquire, ready, release };
  return gate;
});
