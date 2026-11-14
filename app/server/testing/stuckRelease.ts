import { Deferred, Effect, Layer } from 'effect';
import { ChildProcessSpawner } from 'effect/process';

/**
 * The platform's spawner, except that the release of each program it spawns, once the program is killed and gone, waits
 * for `unstick`: what a program in uninterruptible sleep does to the close of its scope (it does not exit on SIGKILL
 * until its kernel call returns), with a process that does die, so a test can still assert it dead. Built on the
 * spawner of the context; `unstick` ends the closes still waiting, for nothing to be left running after the test.
 */
export const stuckRelease = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const gate = yield* Deferred.make<void>();
  const stuck = ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      // Added before the spawner's own release: it runs after it, the process killed and gone.
      yield* Effect.addFinalizer(() => Deferred.await(gate));
      return yield* spawner.spawn(command);
    }),
  );
  return {
    spawner: stuck,
    layer: Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, stuck),
    unstick: Deferred.succeed(gate, undefined).pipe(Effect.asVoid),
  };
});
