import { NodeRuntime, NodeServices } from '@effect/platform-node';
import { Cause, Console, Effect, Exit, Option, Predicate, Runtime } from 'effect';

/** The message of a tagged error that has one: what the user reads. */
const userMessage = (error: unknown): Option.Option<string> =>
  Predicate.hasProperty(error, '_tag') &&
  Predicate.hasProperty(error, 'message') &&
  Predicate.isString(error.message) &&
  error.message !== ''
    ? Option.some(error.message)
    : Option.none();

/**
 * What a failure prints on stderr: nothing when it was already shown (a usage error, printed by the CLI with the
 * help), `llama-webui: <message>` for a tagged error that has a message, the pretty cause otherwise.
 */
const report = <E>(cause: Cause.Cause<E>): Effect.Effect<void> => {
  if (Cause.hasInterruptsOnly(cause)) return Effect.void;
  const error = Cause.findErrorOption(cause);
  if (Option.isSome(error) && !Runtime.getErrorReported(error.value)) return Effect.void;
  return Option.match(Option.flatMap(error, userMessage), {
    onSome: (message) => Console.error(`llama-webui: ${message}`),
    onNone: () => Console.error(Cause.pretty(cause)),
  });
};

/**
 * Runs a program as the process, on the Node platform services (files, paths, terminal, stdio, child processes): exit 0 when it ends or on SIGINT/SIGTERM once undone; exit 1 on a failure, with
 * `llama-webui: <message>` on stderr for a tagged error that has a message, the pretty cause otherwise; a second
 * signal while stopping exits at once, as the Nitro server did.
 */
export function runApp<E>(program: Effect.Effect<void, E, NodeServices.NodeServices>): void {
  // `runMain` interrupts the program on the first signal and only interrupts it again on the next ones: the one signal
  // handler of our own forces the exit on the second, finalizers or not (130, as for an interrupted process).
  let signals = 0;
  const onSignal = () => {
    signals += 1;
    if (signals > 1) process.exit(130);
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  NodeRuntime.runMain(program.pipe(Effect.tapCause(report), Effect.provide(NodeServices.layer)), {
    disableErrorReporting: true,
    teardown: (exit, onExit) => {
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
      // A stop on a signal is a normal end: 0, not runMain's 130.
      onExit(Exit.isSuccess(exit) || Cause.hasInterruptsOnly(exit.cause) ? 0 : 1);
    },
  });
}
