import { Array as Arr, Cause, type Duration, Effect, Layer, Option, Predicate, Schedule } from 'effect';
import { BenchRunner } from '../bench/BenchRunner.ts';
import { SettingsRepo } from '../settings/SettingsRepo.ts';
import { Supervisor } from './Supervisor.ts';

/**
 * One look for a llama-server llama-webui did not start: none while the bench runner is busy (a benchmark owns the
 * port: its trial server is not an external one); in `external`, whether that server is gone; in `idle` or
 * `crashed`, a server on the `port` setting, then on the port of the last command (#28), each looked at once,
 * the first one found kept; otherwise nothing (llama-webui runs its own).
 */
const check = Effect.gen(function* () {
  const runner = yield* BenchRunner;
  if (yield* runner.busy) return;
  const supervisor = yield* Supervisor;
  const settings = yield* SettingsRepo;
  const state = yield* supervisor.state;
  if (state.kind === 'external') return yield* supervisor.recheckExternal;
  if (state.kind !== 'idle' && state.kind !== 'crashed') return;
  const { port } = yield* settings.get;
  const last = yield* supervisor.lastCommand;
  const ports = Arr.dedupe([port, ...Option.match(last, { onNone: () => [], onSome: (cmd) => [cmd.port] })]);
  yield* Effect.findFirst(ports, supervisor.detectExternal);
}).pipe(Effect.withSpan('ExternalWatch.check'));

/**
 * The watch of a llama-server started by hand (#39): a fiber of the layer's scope that looks once as soon as it is
 * built, without holding the start of the app, then every `interval`, one look at a time. A look that dies on a
 * defect (the database failing…) is logged and the next one runs: the watch lasts as long as the app. It provides
 * nothing.
 */
const layerWith = (options: {
  readonly interval: Duration.Input;
}): Layer.Layer<never, never, Supervisor | SettingsRepo | BenchRunner> =>
  Layer.effectDiscard(
    check.pipe(
      Effect.catchCauseIf(Predicate.not(Cause.hasInterruptsOnly), (cause) =>
        Effect.logError('a look for an external llama-server failed', cause),
      ),
      Effect.repeat(Schedule.spaced(options.interval)),
      Effect.forkScoped,
    ),
  );

export const ExternalWatch = {
  layerWith,
  /** Every 2 s. */
  layer: layerWith({ interval: '2 seconds' }),
};
