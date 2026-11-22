import { Api, isLoopback, type SetupReport } from '@llama-webui/shared';
import { Array as Arr, Effect, FileSystem, Number as Num, Option } from 'effect';
import { HttpApiBuilder } from 'effect/http-api';
import { benchBinary } from 'llamacpp-js/node';
import { BenchHardware } from '../bench/BenchHardware.ts';
import { which } from '../bench/which.ts';
import { readTrimmed } from '../collectors/read.ts';
import { AppConfig } from '../config/AppConfig.ts';
import { expandHome, type homeDir } from '../config/Home.ts';
import type { GgufReader } from '../models/GgufReader.ts';
import type { ModelCacheRepo } from '../models/ModelCacheRepo.ts';
import { scanModels } from '../models/scan.ts';
import { Monitor } from '../monitor/Monitor.ts';
import { SettingsRepo } from '../settings/SettingsRepo.ts';
import { resolveBinary } from './sysinfo.ts';

/** Where the kernel says who may read the performance counters (the memory bandwidth of the System page). */
const PERF_PARANOID = '/proc/sys/kernel/perf_event_paranoid';

type Taken =
  | FileSystem.FileSystem
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
 * `/api/setup`, the report of the first run (the binary, llama-bench and its devices, the models folder, the
 * telemetry, where llama-webui and llama-server listen).
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

    return handlers.handle('setup', () => setup);
  }),
);
