import {
  Api,
  type BenchSpec,
  NothingToRun,
  RunNotFound,
  RunStillRunning,
  SweepNotFound,
  type SweepSpec,
  SweepStillRunning,
} from '@llama-webui/shared';
import { Array as Arr, Effect, type FileSystem, type Path } from 'effect';
import { HttpApiBuilder } from 'effect/http-api';
import { SqlClient } from 'effect/sql';
import { benchBinary } from 'llamacpp-js/node';
import { expandHome, type homeDir } from '../config/Home.ts';
import { checkModelPaths } from '../models/allowedPath.ts';
import type { GgufReader } from '../models/GgufReader.ts';
import type { ProfilesRepo } from '../profiles/ProfilesRepo.ts';
import { SettingsRepo } from '../settings/SettingsRepo.ts';
import { checkPathForm, loadModel, mmprojBytes } from '../tuning/models.ts';
import { planSweep } from '../tuning/space.ts';
import { TuningHardware } from '../tuning/TuningHardware.ts';
import { WsHub } from '../ws/WsHub.ts';
import { BenchHardware } from './BenchHardware.ts';
import { BenchRunner } from './BenchRunner.ts';
import { BenchRunsRepo, runFilters } from './BenchRunsRepo.ts';
import { SweepsRepo } from './SweepsRepo.ts';
import { fromProfile, toProfile } from './toProfile.ts';

type Taken =
  | FileSystem.FileSystem
  | Path.Path
  | ProfilesRepo
  | SweepsRepo
  | BenchRunsRepo
  | SettingsRepo
  | Effect.Services<typeof homeDir>;

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
      .handle('run', ({ payload }) =>
        checkModelPaths(payload.spec).pipe(
          Effect.provideContext(services),
          Effect.andThen(runner.start(payload.spec, { stopServer: payload.stopServer === true })),
        ),
      )
      .handle('remove', ({ params }) => remove(params.id))
      .handle('cancel', ({ params }) => runner.cancel(params.id))
      .handle('toProfile', ({ params }) => toProfile(params.id).pipe(Effect.provideContext(services)));
  }),
);

/**
 * The endpoints of `/api/sweeps`: the list, a sweep with its items, its deletion, its cancel, its resume and its
 * validation (the last two start in the background, through the runner), and its creation: the plan of
 * `POST /api/tuning/plan`, then the runner.
 */
export const SweepsHandlers = HttpApiBuilder.group(
  Api,
  'sweeps',
  Effect.fn(function* (handlers) {
    const runner = yield* BenchRunner;
    const runs = yield* BenchRunsRepo;
    const sweeps = yield* SweepsRepo;
    const hub = yield* WsHub;
    const hardware = yield* TuningHardware;
    const sql = yield* SqlClient.SqlClient;
    const files = yield* Effect.context<FileSystem.FileSystem | GgufReader | Path.Path | ProfilesRepo | SettingsRepo>();

    /**
     * A sweep planned on its GGUF (the loading errors of the plan), then started: under the runner's claim, a plan
     * that keeps no item is a 409, else the sweep and its items are written in one transaction.
     */
    const create = Effect.fn('SweepsHandlers.create')(function* (spec: SweepSpec, stopServer: boolean) {
      yield* checkPathForm(spec.modelPath);
      yield* checkModelPaths(spec).pipe(Effect.provideContext(files));
      const { model, mmproj, hw } = yield* Effect.all(
        { model: loadModel(spec.modelPath), mmproj: mmprojBytes(spec.mmprojPath), hw: hardware.read },
        { concurrency: 'unbounded' },
      ).pipe(Effect.provideContext(files));
      const plan = planSweep({ model, hw, spec, mmprojBytes: mmproj });
      const { modelPath, mmprojPath, profileId, serverArgs, p, n, r } = spec;
      const sweep = yield* runner.startSweep({
        files: spec,
        stopServer,
        check:
          plan.items.length === 0
            ? Effect.fail(
                NothingToRun.make({ message: `No configuration to run: ${plan.excluded} excluded by the estimator` }),
              )
            : Effect.void,
        prepare: Effect.gen(function* () {
          const created = yield* sweeps.create(spec);
          yield* runs.enqueue(
            created.id,
            Arr.map(plan.items, (item) => {
              const itemSpec: BenchSpec = {
                kind: 'bench',
                modelPath,
                mmprojPath,
                profileId,
                params: item.params,
                serverArgs,
                p,
                n,
                r,
              };
              return { spec: itemSpec, label: item.label, fit: item.fit.verdict };
            }),
          );
          return created.id;
        }).pipe(sql.withTransaction, Effect.orDie),
      });
      return { sweep, items: plan.items.length, excluded: plan.excluded };
    });

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
      .handle('create', ({ payload }) => create(payload.spec, payload.stopServer === true))
      .handle('get', ({ params }) => get(params.id))
      .handle('remove', ({ params }) => remove(params.id))
      .handle('cancel', ({ params }) => runner.cancelSweep(params.id))
      .handle('resume', ({ params, payload }) => runner.resume(params.id, { stopServer: payload.stopServer === true }))
      .handle('validate', ({ params, payload }) =>
        runner.validate(params.id, { n: payload.n, stopServer: payload.stopServer === true }),
      );
  }),
);
