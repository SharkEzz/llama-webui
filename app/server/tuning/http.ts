import { Api, BenchRunning, type ChecksReport } from '@llama-webui/shared';
import { Array as Arr, Clock, Effect, type FileSystem, Option, type Path, String as Str } from 'effect';
import { HttpApiBuilder } from 'effect/http-api';
import type { ChildProcessSpawner } from 'effect/process';
import { BenchRunner } from '../bench/BenchRunner.ts';
import { expandHome } from '../config/Home.ts';
import { LogRing } from '../logs/LogRing.ts';
import { checkModelPath } from '../models/allowedPath.ts';
import type { GgufReader } from '../models/GgufReader.ts';
import { Monitor } from '../monitor/Monitor.ts';
import type { ProfilesRepo } from '../profiles/ProfilesRepo.ts';
import { SettingsRepo } from '../settings/SettingsRepo.ts';
import { runChecks, summarize } from './checks.ts';
import { measureDiskSpeed } from './disk.ts';
import { estimate } from './estimate.ts';
import { loadTuningInputs } from './inputs.ts';
import { retainedBusIds } from './match.ts';
import { checkPathForm, loadModel } from './models.ts';
import { planSweep } from './space.ts';
import { readSys } from './sysinfo.ts';
import { TuningHardware } from './TuningHardware.ts';
import { TuningMemo } from './TuningMemo.ts';

type Taken =
  | SettingsRepo
  | ProfilesRepo
  | FileSystem.FileSystem
  | Path.Path
  | GgufReader
  | ChildProcessSpawner.ChildProcessSpawner;

/**
 * The endpoints of `/api/tuning`: the system checks against a model, the hardware the estimator plans on, the disk
 * measure, the memory estimate and the plan of a sweep. The last estimate and disk measure of each model are kept
 * (`TuningMemo`) for the checks.
 */
export const TuningHandlers = HttpApiBuilder.group(
  Api,
  'tuning',
  Effect.fn(function* (handlers) {
    const hardware = yield* TuningHardware;
    const memo = yield* TuningMemo;
    const monitor = yield* Monitor;
    const logs = yield* LogRing;
    const settings = yield* SettingsRepo;
    const runner = yield* BenchRunner;
    // Taken when the routes are built: a handler then needs nothing from the request.
    const services = yield* Effect.context<Taken>();

    /** The checks of the machine, against the model at `model` when one is given (an unreadable one is left out). */
    const checks = Effect.fn('TuningHandlers.checks')(function* (model: string | undefined) {
      const modelPath = model === undefined || Str.isEmpty(model) ? null : model;
      if (modelPath !== null) yield* checkModelPath(modelPath);
      const snapshot = yield* monitor.latest;
      const gpus = snapshot?.allGpus ?? [];
      const nvml = yield* monitor.nvmlSystem;
      const logLines = yield* logs.since(0);
      const { binary } = yield* settings.get;
      const expanded = yield* expandHome(binary);
      const { hw, info, readings } = yield* Effect.all(
        {
          hw: hardware.read,
          info: modelPath === null ? Effect.succeedNone : Effect.option(loadModel(modelPath)),
          readings: readSys({
            binary: expanded,
            modelPath,
            logLines,
            nvml,
            busIds: Arr.map(gpus, (g) => g.busId),
            hipTargets: memo.hipTargets,
          }),
        },
        { concurrency: 'unbounded' },
      );
      const last = modelPath === null ? Option.none() : yield* memo.estimates.get(modelPath);
      const disk = modelPath === null ? Option.none() : yield* memo.diskSpeeds.get(modelPath);
      const lastEstimate = Option.getOrNull(last);
      const now = yield* Clock.currentTimeMillis;
      const list = runChecks({
        readings,
        gpus,
        // Only the cards the estimate runs on: the others are `na` (#36).
        retainedBusIds: retainedBusIds({ devices: hw.devices, gpus, dev: lastEstimate?.params.dev }),
        devices: hw.devices,
        cpu: hw.cpu,
        model: Option.getOrNull(info),
        estimate: lastEstimate,
        mem: snapshot?.system?.mem ?? null,
        diskSpeed: Option.getOrNull(disk),
        now,
      });
      const report: ChecksReport = { checks: list, summary: summarize(list), at: now };
      return report;
    });

    /** A sequential read of the model's file, refused while a benchmark runs (it would skew both). */
    const diskSpeed = Effect.fn('TuningHandlers.diskSpeed')(function* (modelPath: string) {
      if (yield* runner.busy) {
        return yield* BenchRunning.make({ message: 'A benchmark is running: the measurement would be skewed' });
      }
      yield* checkPathForm(modelPath);
      yield* checkModelPath(modelPath);
      yield* loadModel(modelPath);
      const speed = yield* measureDiskSpeed({ path: modelPath });
      yield* memo.diskSpeeds.set(modelPath, speed);
      return speed;
    });

    /** The model, its projector's size and the hardware, read together, once the paths are allowed. */
    const inputs = (files: { readonly modelPath: string; readonly mmprojPath?: string | null | undefined }) =>
      loadTuningInputs(files).pipe(Effect.provideService(TuningHardware, hardware));

    return handlers
      .handle('checks', ({ query }) => checks(query.model).pipe(Effect.provideContext(services)))
      .handle('hardware', () => hardware.read)
      .handle('diskSpeed', ({ payload }) => diskSpeed(payload.modelPath).pipe(Effect.provideContext(services)))
      .handle('estimate', ({ payload }) =>
        Effect.gen(function* () {
          const { model, mmproj, hw } = yield* inputs(payload);
          const result = estimate({
            model,
            hw,
            preset: payload.preset,
            mmprojBytes: mmproj,
            pinned: payload.pinned,
            ctx: payload.ctx,
          });
          // Kept even when it does not fit: the checks read the cards it would run on.
          yield* memo.estimates.set(payload.modelPath, result);
          return result;
        }).pipe(Effect.provideContext(services), Effect.withSpan('TuningHandlers.estimate')),
      )
      .handle('plan', ({ payload }) =>
        Effect.gen(function* () {
          const { model, mmproj, hw } = yield* inputs(payload.spec);
          return planSweep({ model, hw, spec: payload.spec, mmprojBytes: mmproj });
        }).pipe(Effect.provideContext(services), Effect.withSpan('TuningHandlers.plan')),
      );
  }),
);
