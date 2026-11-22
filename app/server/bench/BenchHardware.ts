import type { BenchDevice, BenchHardware as Hardware } from '@llama-webui/shared';
import {
  Array as Arr,
  Cache,
  Context,
  Duration,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Metric,
  Option,
  Path,
  Ref,
  Schema,
  Scope,
  type Stream,
} from 'effect';
import { ChildProcess, ChildProcessSpawner } from 'effect/process';
import { parseDeviceList } from 'llamacpp-js/bench';
import { expandHome } from '../config/Home.ts';
import { CpuInfo } from '../hardware/CpuInfo.ts';
import { boundedText, OutputTooLarge } from '../process/bounded.ts';
import { causeMessage, endingOf } from '../process/ending.ts';
import { closeWithin } from '../process/followed.ts';
import { CacheMetrics, cacheLoad, cacheLookup } from '../runtime/Metrics.ts';
import { SettingsRepo } from '../settings/SettingsRepo.ts';
import { which } from './which.ts';

const VERSION = /build (\d+), commit (\w+)/;

/** Backends whose devices own memory: one listed with 0 MiB means the listing went wrong (BLAS, CPU… have none). */
const GPU_BACKEND = /^(CUDA|ROCm|HIP|Vulkan|MUSA|SYCL|Metal|OpenCL|CANN)$/;

/** The devices of `llama-bench --list-devices`, and why the listing is not trusted (they are then the last good list). */
export interface DeviceList {
  readonly devices: ReadonlyArray<BenchDevice>;
  readonly error: string | null;
}

/** What a GPU of the monitor gives the hardware of a run. */
export interface HardwareGpu {
  readonly name: string;
  readonly busId: string;
  readonly vramTotalBytes: number;
}

/** A cache key: a binary as it was given, its file and the file's modification time (a rebuild is read again). */
interface Key {
  readonly binary: string;
  readonly file: string;
  readonly mtime: number;
}

/** Why a short command gave no output to read. */
type OutputFailure =
  | { readonly _tag: 'Spawn'; readonly message: string }
  | { readonly _tag: 'Ended'; readonly message: string }
  | { readonly _tag: 'Timeout'; readonly message: string };

/** The machine a run runs on: the CPU, the GPUs, the llama.cpp build, and the devices llama-bench sees. */
export class BenchHardware extends Context.Service<
  BenchHardware,
  {
    /** “b12119 (6f1e65437)” from `<binary> --version` (`~` expanded), per binary and modification time; null if unreadable. */
    readonly build: (binary: string) => Effect.Effect<string | null>;
    /**
     * `<benchBinary> --list-devices` (`~` expanded), per binary and modification time. A failed listing (missing tool,
     * crash, GPU without memory) is not kept and gives the last good list ([] if none) with the reason.
     */
    readonly devices: (benchBinary: string) => Effect.Effect<DeviceList>;
    /** The devices of `devices`. */
    readonly listDevices: (benchBinary: string) => Effect.Effect<ReadonlyArray<BenchDevice>>;
    /** The hardware at the start of a run: the CPU (read once), `gpus`, and the build of the `binary` setting. */
    readonly hardware: (gpus: ReadonlyArray<HardwareGpu>) => Effect.Effect<Hardware>;
  }
>()('@llama-webui/app/server/bench/BenchHardware') {
  static readonly layerWith = (options: {
    readonly listTimeout: Duration.Input;
    readonly versionTimeout: Duration.Input;
  }): Layer.Layer<
    BenchHardware,
    never,
    SettingsRepo | CpuInfo | ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
  > =>
    Layer.effect(
      BenchHardware,
      Effect.gen(function* () {
        const settings = yield* SettingsRepo;
        const cpuInfo = yield* CpuInfo;
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const fs = yield* FileSystem.FileSystem;
        const paths = yield* Path.Path;
        const platform = Context.make(FileSystem.FileSystem, fs).pipe(Context.add(Path.Path, paths));

        const MAX_OUTPUT = 1024 * 1024;

        const isTooLarge = Schema.is(OutputTooLarge);

        /** All of `stream` as text; more than `MAX_OUTPUT` bytes fails the command, an unreadable stream reads as ''. */
        const text = <E, R>(stream: Stream.Stream<Uint8Array, E, R>) =>
          boundedText(stream, MAX_OUTPUT).pipe(
            Effect.catch((error) =>
              isTooLarge(error)
                ? Effect.fail<OutputFailure>({ _tag: 'Ended', message: 'printed more than 1 MiB' })
                : Effect.succeed(''),
            ),
          );

        /**
         * Stdout then stderr of `<binary> <arg>`, killed after `timeout` or as soon as it prints more than 1 MiB; fails
         * when it cannot start, fails, crashes or prints too much.
         */
        const output = (binary: string, arg: string, timeout: Duration.Input) =>
          Effect.acquireUseRelease(
            Scope.make(),
            (own) =>
              Effect.gen(function* () {
                const handle = yield* spawner
                  .spawn(ChildProcess.make(binary, [arg], { stdin: 'ignore', killSignal: 'SIGKILL' }))
                  .pipe(
                    Scope.provide(own),
                    Effect.mapError((e): OutputFailure => ({ _tag: 'Spawn', message: causeMessage(e) })),
                  );
                const [out, err, ended] = yield* Effect.all(
                  [text(handle.stdout), text(handle.stderr), Effect.result(handle.exitCode)],
                  { concurrency: 3 },
                );
                const { code, signal } = endingOf(ended);
                if (signal !== null)
                  return yield* Effect.fail<OutputFailure>({ _tag: 'Ended', message: `killed by ${signal}` });
                if (code !== 0)
                  return yield* Effect.fail<OutputFailure>({
                    _tag: 'Ended',
                    message: `exited with code ${code ?? '-'}`,
                  });
                return `${out}\n${err}`;
              }),
            (own) => closeWithin({ scope: own, name: `${binary} ${arg}` }),
          ).pipe(
            Effect.timeoutOrElse({
              duration: timeout,
              orElse: () =>
                Effect.fail<OutputFailure>({
                  _tag: 'Timeout',
                  message: `timed out after ${Duration.format(Duration.fromInputUnsafe(timeout))}`,
                }),
            }),
          );

        /** The key of a binary: its file in the PATH (the name itself when it is not found) and the file's mtime. */
        const keyOf = Effect.fn('BenchHardware.keyOf')(function* (given: string) {
          const binary = yield* Effect.provideContext(expandHome(given), platform);
          const found = yield* Effect.provideContext(which(binary), platform);
          const file = Option.getOrElse(found, () => binary);
          const info = yield* fs.stat(file).pipe(Effect.option);
          const mtime = Option.flatMap(info, (i) => i.mtime).pipe(
            Option.map((d) => d.getTime()),
            Option.getOrElse(() => 0),
          );
          const key: Key = { binary, file, mtime };
          return key;
        });

        const readBuild = (key: Key) =>
          Effect.andThen(cacheLoad('bench_build'), output(key.binary, '--version', options.versionTimeout)).pipe(
            Effect.map((version) =>
              Option.fromNullishOr(VERSION.exec(version)).pipe(
                Option.map((m) => `b${m[1]} (${m[2]})`),
                Option.getOrNull,
              ),
            ),
            Effect.orElseSucceed(() => null),
            Effect.withSpan('BenchHardware.readBuild'),
          );
        const builds = yield* Cache.makeWith(readBuild, {
          capacity: Number.MAX_SAFE_INTEGER,
          timeToLive: () => Duration.infinity,
        });

        /** Last complete list per binary: what a failed listing falls back to. */
        const lastGood = yield* Ref.make<ReadonlyMap<string, ReadonlyArray<BenchDevice>>>(new Map());
        const lastGoodOf = (binary: string) =>
          Ref.get(lastGood).pipe(Effect.map((m) => Option.fromNullishOr(m.get(binary))));

        const readDevices = Effect.fn('BenchHardware.readDevices')(function* (key: Key) {
          yield* cacheLoad('bench_devices');
          const listed = yield* Effect.result(output(key.binary, '--list-devices', options.listTimeout));
          const previous = yield* lastGoodOf(key.binary);
          const fallback = Option.isSome(previous) ? Metric.update(CacheMetrics.devicesFallback, 1) : Effect.void;
          if (listed._tag === 'Failure') {
            // A crash while llama-server runs prints a truncated list (#15): never trust it.
            const failure = listed.failure;
            const error = failure._tag === 'Spawn' ? failure.message : `llama-bench --list-devices ${failure.message}`;
            const list: DeviceList = { devices: Option.getOrElse(previous, () => []), error };
            yield* fallback;
            return list;
          }
          const devices = parseDeviceList(listed.success);
          const empty = Arr.findFirst(devices, (d) => GPU_BACKEND.test(d.backend) && d.totalMib <= 0);
          if (Option.isSome(empty)) {
            const list: DeviceList = {
              devices: Option.getOrElse(previous, () => devices),
              error: `${empty.value.id} listed without memory`,
            };
            yield* fallback;
            return list;
          }
          if (Arr.isReadonlyArrayNonEmpty(devices))
            yield* Ref.update(lastGood, (m) => new Map(m).set(key.binary, devices));
          const list: DeviceList = { devices, error: null };
          return list;
        });
        // A good list stays; an error or an empty list is not kept, so the next call lists again.
        const deviceLists = yield* Cache.makeWith(readDevices, {
          capacity: Number.MAX_SAFE_INTEGER,
          timeToLive: (exit) =>
            Exit.isSuccess(exit) && exit.value.error === null && Arr.isReadonlyArrayNonEmpty(exit.value.devices)
              ? Duration.infinity
              : Duration.zero,
        });

        const cpu = Effect.map(cpuInfo.read, (info) => info.model);

        const build = Effect.fn('BenchHardware.build')(function* (binary: string) {
          const key = yield* keyOf(binary);
          yield* cacheLookup('bench_build');
          return yield* Cache.get(builds, key);
        });

        const devices = Effect.fn('BenchHardware.devices')(function* (benchBinary: string) {
          const key = yield* keyOf(benchBinary);
          yield* cacheLookup('bench_devices');
          return yield* Cache.get(deviceLists, key);
        });

        const listDevices = (benchBinary: string) => Effect.map(devices(benchBinary), (list) => list.devices);

        const hardware = Effect.fn('BenchHardware.hardware')(function* (gpus: ReadonlyArray<HardwareGpu>) {
          const { binary } = yield* settings.get;
          const model = yield* cpu;
          const built = yield* build(binary);
          const frozen: Hardware = {
            cpu: model,
            gpus: Arr.map(gpus, (g) => ({ name: g.name, busId: g.busId, vramTotalBytes: g.vramTotalBytes })),
            build: built,
          };
          return frozen;
        });

        return BenchHardware.of({ build, devices, listDevices, hardware });
      }),
    );

  static readonly layer = BenchHardware.layerWith({ listTimeout: '15 seconds', versionTimeout: '5 seconds' });
}
