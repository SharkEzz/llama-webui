import { Array as Arr, type Duration, Effect, Layer, Option, Schedule } from 'effect';
import { SettingsRepo } from '../settings/SettingsRepo.ts';
import { Supervisor } from './Supervisor.ts';

/**
 * One look for a llama-server llama-webui did not start: in `external`, whether that server is gone; in `idle` or
 * `crashed`, a server on the `port` setting, then on the port of the last command (#28), each looked at once,
 * the first one found kept; otherwise nothing (llama-webui runs its own).
 */
const check = Effect.gen(function* () {
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
 * built, without holding the start of the app, then every `interval`, one look at a time. It provides nothing.
 */
const layerWith = (options: {
  readonly interval: Duration.Input;
}): Layer.Layer<never, never, Supervisor | SettingsRepo> =>
  Layer.effectDiscard(check.pipe(Effect.repeat(Schedule.spaced(options.interval)), Effect.forkScoped));

export const ExternalWatch = {
  layerWith,
  /** Every 2 s. */
  layer: layerWith({ interval: '2 seconds' }),
};
