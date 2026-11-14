import { Deferred, Effect, Exit, Scope } from 'effect';
import { ChildProcessSpawner } from 'effect/process';

/**
 * The platform's spawner, except that the release of each program it spawned, once the program is killed and gone, waits
 * for `unstick`: what a program in uninterruptible sleep does to the close of its scope (it does not exit on SIGKILL
 * until its kernel call returns), with a process that does die, so a test can still assert it dead. Built on the
 * spawner of the context; `unstick` ends the closes still waiting, for nothing to be left running after the test.
 */
export const stuckRelease = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const gate = yield* Deferred.make<void>();
  const stuck = ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      const inner = yield* Scope.make();
      const handle = yield* spawner.spawn(command).pipe(
        Scope.provide(inner),
        Effect.onError(() => Scope.close(inner, Exit.void)),
      );
      // A spawned program only: the spawner's own release first (the process killed and gone), then the wait.
      yield* Effect.addFinalizer(() => Scope.close(inner, Exit.void).pipe(Effect.andThen(Deferred.await(gate))));
      return handle;
    }),
  );
  return {
    spawner: stuck,
    unstick: Deferred.succeed(gate, undefined).pipe(Effect.asVoid),
  };
});
