import { Api, RunNotFound, RunStillRunning, SweepNotFound, SweepStillRunning } from '@llama-webui/shared';
import { Effect, type Path } from 'effect';
import { HttpApiBuilder } from 'effect/http-api';
import { benchBinary } from 'llamacpp-js/node';
import { expandHome, type homeDir } from '../config/Home.ts';
import type { ProfilesRepo } from '../profiles/ProfilesRepo.ts';
import { SettingsRepo } from '../settings/SettingsRepo.ts';
import { WsHub } from '../ws/WsHub.ts';
import { BenchHardware } from './BenchHardware.ts';
import { BenchRunner } from './BenchRunner.ts';
import { BenchRunsRepo, runFilters } from './BenchRunsRepo.ts';
import { SweepsRepo } from './SweepsRepo.ts';
import { fromProfile, toProfile } from './toProfile.ts';

type Taken = Path.Path | ProfilesRepo | SweepsRepo | BenchRunsRepo | SettingsRepo | Effect.Services<typeof homeDir>;

/**
 * The endpoints of `/api/bench`: the devices llama-bench sees, a draft from a profile, the runs, a run started in the
 * background, its cancel, its deletion and the profile made from it. The runner publishes the runs as they go; a
 * deletion publishes `bench-deleted`.
 */
export const BenchHandlers = HttpApiBuilder.group(
  Api,
  'bench',
  Effect.fn(function* (handlers) {
    const runner = yield* BenchRunner;
    const runs = yield* BenchRunsRepo;
    const settings = yield* SettingsRepo;
    const hardware = yield* BenchHardware;
    const hub = yield* WsHub;
    // Taken when the routes are built: a handler then needs nothing from the request.
    const services = yield* Effect.context<Taken>();

    /** The devices `llama-bench` next to the `binary` setting (`~` expanded) lists. */
    const devices = Effect.gen(function* () {
      const { binary } = yield* settings.get;
      const expanded = yield* expandHome(binary).pipe(Effect.provideContext(services));
      return yield* hardware.listDevices(benchBinary(expanded));
    }).pipe(Effect.withSpan('BenchHandlers.devices'));

    /** The failed, cancelled and interrupted one-off runs deleted; `bench-deleted` when some went. */
    const deleteFailed = Effect.gen(function* () {
      const ids = yield* runs.deleteFailed;
      if (ids.length > 0) yield* hub.publish({ type: 'bench-deleted', payload: { ids } });
      return { deleted: ids.length };
    }).pipe(Effect.withSpan('BenchHandlers.deleteFailed'));

    /** A run that is not running deleted; `bench-deleted` once its row went. */
    const remove = Effect.fn('BenchHandlers.remove')(function* (id: number) {
      const found = yield* runs.get(id);
      if (found._tag === 'None') return yield* RunNotFound.make({ message: 'Run not found' });
      if (found.value.status === 'running') {
        return yield* RunStillRunning.make({ message: 'This run is still running: cancel it first' });
      }
      const went = yield* runs.delete(id);
      if (!went) return yield* RunNotFound.make({ message: 'Run not found' });
      yield* hub.publish({ type: 'bench-deleted', payload: { ids: [id] } });
    });

    return handlers
      .handle('devices', () => devices)
      .handle('fromProfile', ({ params }) => fromProfile(params.id).pipe(Effect.provideContext(services)))
      .handle('runs', ({ query }) =>
        Effect.all({ runs: runs.list(runFilters(query)), live: runner.live }).pipe(
          Effect.withSpan('BenchHandlers.runs'),
        ),
      )
      .handle('deleteFailed', () => deleteFailed)
      .handle('run', ({ payload }) => runner.start(payload.spec, { stopServer: payload.stopServer === true }))
      .handle('remove', ({ params }) => remove(params.id))
      .handle('cancel', ({ params }) => runner.cancel(params.id))
      .handle('toProfile', ({ params }) => toProfile(params.id).pipe(Effect.provideContext(services)));
  }),
);

/**
 * The endpoints of `/api/sweeps`: the list, a sweep with its items, its deletion, its cancel, its resume and its
 * validation (the last two start in the background, through the runner). E8 adds the creation.
 */
export const SweepsHandlers = HttpApiBuilder.group(
  Api,
  'sweeps',
  Effect.fn(function* (handlers) {
    const runner = yield* BenchRunner;
    const runs = yield* BenchRunsRepo;
    const sweeps = yield* SweepsRepo;
    const hub = yield* WsHub;

    const get = Effect.fn('SweepsHandlers.get')(function* (id: number) {
      const found = yield* sweeps.get(id);
      if (found._tag === 'None') return yield* SweepNotFound.make({ message: 'Sweep not found' });
      const items = yield* runs.list(runFilters({ sweep: `${id}` }));
      return { sweep: found.value, runs: items };
    });

    /**
     * A sweep that is not running deleted with its items, in one transaction; then `bench-deleted` (its items' ids,
     * even none) and `sweep-deleted`. A sweep gone meanwhile is a 404, nothing published.
     */
    const remove = Effect.fn('SweepsHandlers.remove')(function* (id: number) {
      const found = yield* sweeps.get(id);
      if (found._tag === 'None') return yield* SweepNotFound.make({ message: 'Sweep not found' });
      if (found.value.status === 'running') {
        return yield* SweepStillRunning.make({ message: 'This sweep is still running: cancel it first' });
      }
      const deleted = yield* sweeps.delete(id);
      if (deleted._tag === 'None') return yield* SweepNotFound.make({ message: 'Sweep not found' });
      yield* hub.publish({ type: 'bench-deleted', payload: { ids: deleted.value.runIds } });
      yield* hub.publish({ type: 'sweep-deleted', payload: { id } });
    });

    return handlers
      .handle('list', () =>
        Effect.all({ sweeps: sweeps.list, live: runner.sweepLive }).pipe(Effect.withSpan('SweepsHandlers.list')),
      )
      .handle('get', ({ params }) => get(params.id))
      .handle('remove', ({ params }) => remove(params.id))
      .handle('cancel', ({ params }) => runner.cancelSweep(params.id))
      .handle('resume', ({ params, payload }) => runner.resume(params.id, { stopServer: payload.stopServer === true }))
      .handle('validate', ({ params, payload }) =>
        runner.validate(params.id, { n: payload.n, stopServer: payload.stopServer === true }),
      );
  }),
);
