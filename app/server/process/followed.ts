import { Deferred, Duration, Effect, Exit, Fiber, Option, type PlatformError, type Result, Scope } from 'effect';
import { type ChildProcess, ChildProcessSpawner } from 'effect/process';

/*
 * A long-lived program in a scope of its own, followed until it exits: its output read, its exit handled once, and its
 * stop bounded even when the kernel does not let it die.
 */

/** How long the end of a program waits for its readers: its last output is not lost. */
export const DRAIN_TIMEOUT = Duration.seconds(1);

/** The backstop of a program's scope closed on a live program: SIGKILL that long after its first signal. */
export const FORCE_KILL_AFTER = Duration.seconds(1);

/** How long a close waits for a killed program to be gone before it leaves it to end on its own. */
export const CLOSE_BOUND = Duration.seconds(1);

/**
 * Closes `scope` in a fiber of its own and waits for it `bound` at most (`CLOSE_BOUND`). The spawner's release of a
 * program kills it, then waits for its exit without a limit, uninterruptibly: a program in uninterruptible sleep (a
 * call stuck in a driver) does not exit on SIGKILL until its kernel call returns, and would hold whoever closes its
 * scope. Past the bound the close is logged and goes on alone; `onClosed` runs once it ended. Answers whether it ended
 * within the bound.
 */
export const closeWithin = Effect.fnUntraced(function* (options: {
  readonly scope: Scope.Closeable;
  /** What the scope holds, for the log: `nvidia-smi`, `the NVML sampler`. */
  readonly name: string;
  readonly bound?: Duration.Input;
  readonly onClosed?: Effect.Effect<void>;
}) {
  const bound = Duration.fromInputUnsafe(options.bound ?? CLOSE_BOUND);
  const closing = yield* Scope.close(options.scope, Exit.void).pipe(
    Effect.ensuring(options.onClosed ?? Effect.void),
    Effect.forkDetach,
  );
  // Made interruptible for the timeout to end it, in a finalizer too.
  const ended = yield* Fiber.await(closing).pipe(Effect.interruptible, Effect.timeoutOption(bound));
  if (Option.isNone(ended))
    yield* Effect.logWarning(`${options.name} did not end ${Duration.format(bound)} after its stop: left to end alone`);
  return Option.isSome(ended);
});

/** A program followed by `followProgram`. */
export interface Followed {
  readonly handle: ChildProcessSpawner.ChildProcessHandle;
  /** The program's scope: its readers, and what the caller forks next to them. Its close kills the program. */
  readonly scope: Scope.Scope;
  /** Kills the program (its scope closed) and waits `CLOSE_BOUND` at most for it to be gone. */
  readonly stop: Effect.Effect<void>;
  /** Completes once its exit was handled: its readers joined, `onExit` run, its scope closed. */
  readonly ended: Effect.Effect<void>;
}

/**
 * Spawns `command` in a scope of its own, forked from `parent`, and follows it: `onSpawn` (the caller names it in its
 * state, before any output is read), then `read` in the program's scope; once it exits, a fiber of `parent` joins
 * `read` (`DRAIN_TIMEOUT` at most), runs `onExit` with how it ended (its code, or the failure of `exitCode`, which
 * names the signal that ended it), then closes its scope, uninterruptibly. The close of the program's scope, by
 * `stop`, by its exit or by the end of `parent`, waits `CLOSE_BOUND` at most for a killed program to be gone. A spawn
 * that fails fails with the spawner's error, nothing left behind.
 */
export const followProgram = Effect.fnUntraced(function* <R1 = never, R2 = never, R3 = never>(options: {
  readonly command: ChildProcess.Command;
  readonly parent: Scope.Scope;
  /** The program in the logs. */
  readonly name: string;
  readonly onSpawn?: (program: Followed) => Effect.Effect<void, never, R1>;
  readonly read: (program: Followed) => Effect.Effect<void, never, R2>;
  readonly onExit?: (
    ended: Result.Result<ChildProcessSpawner.ExitCode, PlatformError.PlatformError>,
    program: Followed,
  ) => Effect.Effect<void, never, R3>;
}): Effect.fn.Return<Followed, PlatformError.PlatformError, ChildProcessSpawner.ChildProcessSpawner | R1 | R2 | R3> {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const own = yield* Scope.fork(options.parent);
  // The program itself, in a scope of no parent: only `own`'s last finalizer closes it, with a bound.
  const release = yield* Scope.make();
  yield* Scope.addFinalizer(own, closeWithin({ scope: release, name: options.name }));
  const stop = Scope.close(own, Exit.void);
  const spawned = yield* spawner.spawn(options.command).pipe(Scope.provide(release), Effect.result);
  if (spawned._tag === 'Failure') {
    yield* stop;
    return yield* spawned.failure;
  }
  const drained = yield* Deferred.make<void>();
  const ended = yield* Deferred.make<void>();
  const program: Followed = { handle: spawned.success, scope: own, stop, ended: Deferred.await(ended) };
  if (options.onSpawn !== undefined) yield* options.onSpawn(program);
  yield* options.read(program).pipe(Effect.ensuring(Deferred.succeed(drained, undefined)), Effect.forkIn(own));
  const onExit = options.onExit ?? (() => Effect.void);
  yield* program.handle.exitCode.pipe(
    Effect.result,
    Effect.flatMap((exit) =>
      Effect.gen(function* () {
        // Made interruptible for the timeout to end it: the rest runs whatever happens.
        yield* Deferred.await(drained).pipe(Effect.interruptible, Effect.timeoutOption(DRAIN_TIMEOUT));
        yield* onExit(exit, program);
        yield* stop;
        yield* Deferred.succeed(ended, undefined);
      }).pipe(Effect.uninterruptible),
    ),
    Effect.forkIn(options.parent),
  );
  return program;
});
