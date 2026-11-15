import {
  Api,
  ctxFromArgs,
  isLoopback,
  type LaunchpadEntry,
  type Profile,
  paramsFromServerArgs,
  type SetupReport,
} from '@llama-webui/shared';
import { Array as Arr, Effect, FileSystem, Number as Num, Option, Path } from 'effect';
import { HttpApiBuilder } from 'effect/http-api';
import { benchBinary } from 'llamacpp-js/node';
import { BenchHardware } from '../bench/BenchHardware.ts';
import { BenchRunsRepo } from '../bench/BenchRunsRepo.ts';
import { which } from '../bench/which.ts';
import { readTrimmed } from '../collectors/read.ts';
import { AppConfig } from '../config/AppConfig.ts';
import { expandHome, homeDir } from '../config/Home.ts';
import type { GgufReader } from '../models/GgufReader.ts';
import type { ModelCacheRepo } from '../models/ModelCacheRepo.ts';
import { scanModels } from '../models/scan.ts';
import { Monitor } from '../monitor/Monitor.ts';
import { ProfilesRepo } from '../profiles/ProfilesRepo.ts';
import { SettingsRepo } from '../settings/SettingsRepo.ts';
import { profilePaths } from '../supervisor/command.ts';
import { estimate } from './estimate.ts';
import { loadModel, mmprojBytes } from './models.ts';
import { resolveBinary } from './sysinfo.ts';
import { TuningHardware } from './TuningHardware.ts';

/** Where the kernel says who may read the performance counters (the memory bandwidth of the System page). */
const PERF_PARANOID = '/proc/sys/kernel/perf_event_paranoid';

type Taken =
  | ProfilesRepo
  | BenchRunsRepo
  | Monitor
  | TuningHardware
  | FileSystem.FileSystem
  | Path.Path
  | GgufReader
  | ModelCacheRepo
  | Effect.Services<typeof homeDir>
  | Effect.Services<ReturnType<typeof which>>;

/** `kernel.perf_event_paranoid`, null when unreadable. */
const readPerfParanoid = Effect.map(readTrimmed(PERF_PARANOID), (text) => {
  const n = text === null ? Number.NaN : Number.parseInt(text, 10);
  return Number.isFinite(n) ? n : null;
});

/**
 * One card per profile: its model (a model that cannot be read only sets `modelError`), the fit of the estimator's
 * `fit` preset under the profile's own args, and its last successful benchmark. The cards are built together.
 */
export const buildLaunchpad = Effect.gen(function* () {
  const profiles = yield* ProfilesRepo;
  const runs = yield* BenchRunsRepo;
  const monitor = yield* Monitor;
  const hardware = yield* TuningHardware;
  const path = yield* Path.Path;
  const home = yield* homeDir;
  const cwd = path.resolve('.');
  const list = yield* profiles.list;
  const lastBench = yield* runs.lastOkByProfile;
  const snapshot = yield* monitor.latest;
  const gpus = snapshot?.allGpus.length ?? 0;
  // Read once for every profile, and only when one has a model.
  const hw = yield* Effect.cached(hardware.read);

  const entryOf = Effect.fnUntraced(function* (profile: Profile) {
    const run = lastBench.get(profile.id);
    const base = {
      profileId: profile.id,
      name: profile.name,
      lastBench:
        run === undefined ? null : { ppTps: run.pp?.tps ?? null, tgTps: run.tg?.tps ?? null, at: run.createdAt },
      model: null,
      fit: null,
    };
    const paths = profilePaths({ profile, home, cwd, path });
    const loaded = yield* Effect.all([loadModel(paths.model), mmprojBytes(paths.mmproj)], {
      concurrency: 'unbounded',
    }).pipe(Effect.result);
    if (loaded._tag === 'Failure') {
      const failed: LaunchpadEntry = { ...base, modelPath: paths.model, modelError: loaded.failure.message };
      return failed;
    }
    const [info, mmproj] = loaded.success;
    const machine = yield* hw;
    // llama-bench missing while GPUs exist: an estimate without them would be wrong, so no fit badge.
    const known = machine.devices.length > 0 || gpus === 0;
    const fit = known
      ? Option.some(
          estimate({
            model: info,
            hw: machine,
            preset: 'fit',
            mmprojBytes: mmproj,
            pinned: paramsFromServerArgs(profile.args).params,
            ctx: ctxFromArgs(profile.args),
          }).fit,
        )
      : Option.none();
    const entry: LaunchpadEntry = {
      ...base,
      modelPath: paths.model,
      model: { name: info.name, quant: info.quant, fileBytes: info.fileBytes },
      modelError: null,
      fit: Option.getOrNull(
        Option.map(fit, (f) => ({
          verdict: f.verdict,
          reason: f.reason,
          vramBytes: Num.sumAll(Arr.map(f.vram, (v) => v.bytes)),
          ramBytes: f.ramBytes,
        })),
      ),
    };
    return entry;
  });

  return yield* Effect.forEach(list, entryOf, { concurrency: 'unbounded' });
}).pipe(Effect.withSpan('SetupHandlers.launchpad'));

/**
 * `/api/setup`, the report of the first run (the binary, llama-bench and its devices, the models folder, the
 * telemetry, where llama-webui and llama-server listen), and `/api/launchpad`, one card per profile (its model, its
 * fit, its last benchmark).
 */
export const SetupHandlers = HttpApiBuilder.group(
  Api,
  'setup',
  Effect.fn(function* (handlers) {
    const settings = yield* SettingsRepo;
    const bench = yield* BenchHardware;
    const monitor = yield* Monitor;
    const config = yield* AppConfig;
    // Taken when the routes are built: a handler then needs nothing from the request.
    const services = yield* Effect.context<Taken>();

    const setup = Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const current = yield* settings.get;
      const binary = yield* expandHome(current.binary);
      const dir = yield* expandHome(current.modelsDir);
      const benchPath = benchBinary(binary);
      const { resolved, exists, devices, perfParanoid } = yield* Effect.all(
        {
          resolved: resolveBinary(binary),
          exists: fs.stat(dir).pipe(
            Effect.map((info) => info.type === 'Directory'),
            Effect.orElseSucceed(() => false),
          ),
          devices: bench.listDevices(benchPath),
          perfParanoid: readPerfParanoid,
        },
        { concurrency: 'unbounded' },
      );
      // An executable file: `which` of an absolute path checks just that.
      const executable = Option.isNone(resolved) ? Option.none<string>() : yield* which(resolved.value);
      const path = Option.getOrNull(executable);
      // The expanded binary: llama-server is run with `~` expanded, its version is read the same way.
      const version = path === null ? null : yield* bench.build(binary);
      const scanned = exists ? yield* scanModels(dir) : [];
      const models = Arr.filter(scanned, (m) => m.ok && m.kind === 'model');
      const nvidiaSource = yield* monitor.nvidiaSource;
      const report: SetupReport = {
        binary: { setting: current.binary, path, version },
        bench: { path: benchPath, devices },
        models: {
          setting: current.modelsDir,
          dir,
          exists,
          count: models.length,
          bytes: Num.sumAll(Arr.map(models, (m) => m.fileBytes)),
        },
        telemetry: { nvidiaSource, perfParanoid },
        listen: { host: config.host, exposed: !isLoopback(config.host) },
        llamaListen: { host: current.host, exposed: !isLoopback(current.host) },
        ready: path !== null && exists,
      };
      return report;
    }).pipe(Effect.provideContext(services), Effect.withSpan('SetupHandlers.setup'));

    const launchpad = buildLaunchpad.pipe(Effect.provideContext(services));

    return handlers.handle('setup', () => setup).handle('launchpad', () => launchpad);
  }),
);
