import { Context, Effect, Exit, Layer, Scope } from 'effect';

/**
 * Steps that must run while clients are still connected: a reply saved "stopped", a run saved "interrupted", a last
 * message published. `App` builds `layerRunner` last, so its finalizer, which runs the steps, comes first when the app
 * stops: before the HTTP server stops serving (and closes the sockets with 1001), before the services are undone.
 */
export class Shutdown extends Context.Service<
  Shutdown,
  {
    /** Registers a step: it runs when the app stops, before the HTTP server stops serving; last registered, first run. */
    readonly before: (step: Effect.Effect<void>) => Effect.Effect<void>;
    /** Runs the registered steps, once: the finalizer of `layerRunner`. A later call does nothing. */
    readonly run: Effect.Effect<void>;
  }
>()('@llama-webui/app/server/runtime/Shutdown') {
  /** The registry. Should no runner run them, the steps still run when this layer is undone. */
  static readonly layer: Layer.Layer<Shutdown> = Layer.effect(
    Shutdown,
    Effect.gen(function* () {
      const steps = yield* Effect.acquireRelease(Scope.make('sequential'), (scope) => Scope.close(scope, Exit.void));
      const before = Effect.fn('Shutdown.before')(function* (step: Effect.Effect<void>) {
        // A step that fails is logged and does not keep the next ones from running.
        yield* Scope.addFinalizer(
          steps,
          step.pipe(Effect.catchCause((cause) => Effect.logError('a shutdown step failed', cause))),
        );
      });
      return Shutdown.of({ before, run: Scope.close(steps, Exit.void).pipe(Effect.withSpan('Shutdown.run')) });
    }),
  );

  /** The outermost layer of `App`: its finalizer runs the steps. */
  static readonly layerRunner: Layer.Layer<never, never, Shutdown> = Layer.effectDiscard(
    Effect.gen(function* () {
      const { run } = yield* Shutdown;
      yield* Effect.addFinalizer(() => run);
    }),
  );
}
