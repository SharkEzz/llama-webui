import type { DiskSample, GpuReading, NvidiaSource, Settings, SystemSample } from '@llama-webui/shared';
import {
  Array as Arr,
  Clock,
  Config,
  Context,
  Duration,
  Effect,
  Exit,
  Fiber,
  type FileSystem,
  Layer,
  Metric,
  Option,
  type Path,
  Predicate,
  Ref,
  Schema,
  Scope,
  Semaphore,
} from 'effect';
import type { ChildProcessSpawner } from 'effect/process';
import type { PciIds } from '../hardware/PciIds.ts';
import { MonitorMetrics } from '../runtime/Metrics.ts';
import { SettingsRepo } from '../settings/SettingsRepo.ts';
import { type AmdCard, discoverAmdCards, isRuntimeSuspended, readAmdCard, readProcAmdVram } from './amdgpu.ts';
import { makeDiskSampler, physicalDisks, resolveModelDisk } from './disk.ts';
import { type GpuPollConfig, gpuNeeds, type NvidiaReader } from './gpu.ts';
import { type MemBandwidthSampler, makeMemBandwidth } from './membw.ts';
import { makeNvidiaSmi, type NvidiaSmi } from './nvidia.ts';
import { type NvmlReader, startNvml } from './nvml/Nvml.ts';
import type { NvmlSystem } from './nvml/protocol.ts';
import { makeProcSampler } from './proc.ts';
import { makeSystemSampler } from './system.ts';

/** The settings the collectors follow. */
export type CollectorSettings = Pick<Settings, 'collectors' | 'pollIntervalMs' | 'hiddenGpus'>;

/** A change of the settings the collectors could not apply (the settings are saved all the same). */
export class CollectorsNotApplied extends Schema.TaggedError<
  CollectorsNotApplied,
  { readonly CollectorsNotApplied: unique symbol }
>()('CollectorsNotApplied', { message: Schema.String }) {}

/** The AMD cards, discovered once at startup, and how to read them. */
export interface AmdSource {
  readonly cards: ReadonlyArray<AmdCard>;
  readonly read: (card: AmdCard) => Effect.Effect<GpuReading>;
  /** The VRAM of `pid` per card; descriptors open on `skipNodes` (cards not to read) are not read. */
  readonly procVram: (pid: number, skipNodes: ReadonlySet<string>) => Effect.Effect<ReadonlyMap<string, number>>;
  /** A card the kernel put to sleep: listed, never read, so as not to wake it up. */
  readonly suspended: (card: AmdCard) => Effect.Effect<boolean>;
}

/** CPU and memory, and the DRAM bandwidth (perf), which follows the same switch. */
export interface SystemSource {
  readonly sample: Effect.Effect<SystemSample>;
  readonly memBw: MemBandwidthSampler;
}

/** The disks, listed when the collector was switched on. */
export interface DiskSource {
  readonly sample: (modelDisk: string | null) => Effect.Effect<DiskSample>;
  /** The disk that holds `file`; none for a missing file or a filesystem with no block device. */
  readonly resolveModelDisk: (file: string) => Effect.Effect<Option.Option<string>>;
}

/** The system collector while it is on: its perf runs in `scope`, closed when it is switched off. */
interface SystemOn extends SystemSource {
  readonly scope: Scope.Closeable;
}

interface Held {
  readonly system: Option.Option<SystemOn>;
  readonly disk: Option.Option<DiskSource>;
}

const messageOf = (defect: unknown): string => (Predicate.isError(defect) ? defect.message : String(defect));

/** The NVIDIA source of the moment: an NVML sampler (in a scope of its own) or nvidia-smi. */
type Source =
  | { readonly kind: 'nvml'; readonly reader: NvmlReader; readonly scope: Scope.Closeable }
  | { readonly kind: 'nvidia-smi'; readonly reader: NvidiaReader };

/** The pauses before each restart of an NVML sampler that died: three restarts, then nvidia-smi. */
const NVML_RESTART_DELAYS: ReadonlyArray<Duration.Input> = ['1 second', '5 seconds', '30 seconds'];

/** How long a sampler samples before its restarts are counted from zero again. */
const NVML_HEALTHY_AFTER: Duration.Input = '5 minutes';

/**
 * The hardware collectors: NVIDIA through NVML in a child process, else nvidia-smi, the AMD cards through sysfs
 * (discovered once), llama-server's process, and CPU, memory, perf and the disks, each behind the switch of its
 * setting. NVML is tried at startup; a sampler that dies is started again (three times in a row at most, the count
 * starting over after a healthy run), then nvidia-smi takes over for good. `configure` follows the settings, except
 * `collectors.nvml`, read at startup only.
 */
export class Collectors extends Context.Service<
  Collectors,
  {
    readonly nvidia: NvidiaReader;
    /** The NVIDIA source of the moment: NVML, or nvidia-smi from the start or once NVML gave up. */
    readonly nvidiaSource: Effect.Effect<NvidiaSource>;
    /** The driver's versions NVML reports; null with nvidia-smi or before NVML's first sample. */
    readonly nvmlSystem: Effect.Effect<NvmlSystem | null>;
    readonly amd: AmdSource;
    /** CPU % (of one core) and resident memory of a process; none when it cannot be read. */
    readonly proc: (pid: number) => Effect.Effect<Option.Option<{ cpuPct: number; rssBytes: number }>>;
    /** The system collector as it is now: none while it is off. */
    readonly system: Effect.Effect<Option.Option<SystemSource>>;
    /** The disk collector as it is now: none while it is off. */
    readonly disk: Effect.Effect<Option.Option<DiskSource>>;
    /**
     * Applies the settings, one call at a time: the interval and the hidden cards to the NVIDIA reader, the system
     * switch (off stops perf) and the disk switch (on lists the disks again). A call whose caller goes away runs to its
     * end. The readers report no error of their own: `CollectorsNotApplied` carries a part that failed unexpectedly
     * (a defect), so that the settings, saved already, are not answered as lost.
     */
    readonly configure: (settings: CollectorSettings) => Effect.Effect<void, CollectorsNotApplied>;
  }
>()('@llama-webui/app/server/collectors/Collectors') {
  /**
   * The collectors from `initial`. NVML (`nvmlLib`, else the system's library; the sampler `nvmlCommand`, else
   * `worker.ts`) is tried when `collectors.nvml` is on, waiting `readyTimeout` for it; else, or when it does not come
   * up, `nvidiaSmi` is the source, started once the settings are applied. A sampler that dies after its `ready` is
   * started again after each pause of `nvmlRestartDelays` (1 s, 5 s, 30 s), the count starting over once one has
   * lived `nvmlHealthyAfter` (5 min); when they are spent, nvidia-smi. `appsTimeout` bounds nvidia-smi's
   * compute-apps query, `perfRetryAfter` the relaunch of a perf (`perfBin`, else `perf`) that died or failed: each
   * defaults to its reader's own value. The end of the layer stops every program they started.
   */
  static readonly layerWith = (options: {
    readonly initial: CollectorSettings;
    readonly nvmlLib: Option.Option<string>;
    readonly nvidiaSmi: string;
    readonly nvmlCommand?: { readonly cmd: string; readonly args: ReadonlyArray<string> };
    readonly perfBin?: string;
    readonly readyTimeout?: Duration.Input;
    readonly nvmlRestartDelays?: ReadonlyArray<Duration.Input>;
    readonly nvmlHealthyAfter?: Duration.Input;
    readonly appsTimeout?: Duration.Input;
    readonly perfRetryAfter?: Duration.Input;
    /** Where the AMD cards are looked for (`/sys/class/drm` by default). */
    readonly drmRoot?: string;
  }): Layer.Layer<
    Collectors,
    never,
    ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path | PciIds
  > =>
    Layer.effect(
      Collectors,
      Effect.gen(function* () {
        const scope = yield* Effect.scope;
        // The programs (the NVML sampler or nvidia-smi, perf): at the end of the layer, they all stop at once.
        const programs = yield* Scope.fork(scope, 'parallel');
        const context = yield* Effect.context<
          ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
        >();
        const initial = options.initial;

        const lastConfig = yield* Ref.make<GpuPollConfig>({
          intervalMs: initial.pollIntervalMs,
          needs: gpuNeeds(initial.hiddenGpus),
        });
        /** A sampler started with the last settings, in a scope of its own (closed when it does not come up). */
        const tryNvml = Effect.gen(function* () {
          const own = yield* Scope.fork(programs);
          const config = yield* Ref.get(lastConfig);
          const reader = yield* startNvml({
            ...config,
            lib: options.nvmlLib,
            command: options.nvmlCommand,
            readyTimeout: options.readyTimeout,
          }).pipe(Scope.provide(own));
          if (Option.isNone(reader)) yield* Scope.close(own, Exit.void);
          return Option.map(reader, (r): Source => ({ kind: 'nvml', reader: r, scope: own }));
        });
        const smiReader = makeNvidiaSmi({
          bin: options.nvidiaSmi,
          intervalMs: initial.pollIntervalMs,
          appsTimeout: options.appsTimeout,
        }).pipe(Scope.provide(programs));

        const first = initial.collectors.nvml ? yield* tryNvml : Option.none<Source>();
        // nvidia-smi only when NVML did not come up.
        const smi = Option.isSome(first) ? Option.none<NvidiaSmi>() : yield* Effect.asSome(smiReader);
        const source = Option.getOrElse(first, (): Source => ({ kind: 'nvidia-smi', reader: Option.getOrThrow(smi) }));
        const current = yield* Ref.make<Source>(source);
        yield* Metric.update(MonitorMetrics.gpuSource, source.kind);
        /** The reader of the moment: a switch of source is seen by the next call. */
        const nvidia: NvidiaReader = {
          gpus: Effect.flatMap(Ref.get(current), (s) => s.reader.gpus),
          procVram: (pid) => Effect.flatMap(Ref.get(current), (s) => s.reader.procVram(pid)),
          refreshApps: Effect.flatMap(Ref.get(current), (s) => s.reader.refreshApps),
          // Kept for the next source; a switch applies the last one after it (a change made meanwhile is not lost).
          configure: (o) =>
            Ref.set(lastConfig, o).pipe(Effect.andThen(Effect.flatMap(Ref.get(current), (s) => s.reader.configure(o)))),
        };
        /** `next` the source, the last settings applied to it. */
        const switchTo = Effect.fnUntraced(function* (next: Source) {
          yield* Ref.set(current, next);
          yield* Metric.update(MonitorMetrics.gpuSource, next.kind);
          const config = yield* Ref.get(lastConfig);
          yield* next.reader.configure(config);
        });

        const delays = Arr.map(options.nvmlRestartDelays ?? NVML_RESTART_DELAYS, Duration.fromInputUnsafe);
        const healthyMs = Duration.toMillis(Duration.fromInputUnsafe(options.nvmlHealthyAfter ?? NVML_HEALTHY_AFTER));
        /**
         * Follows the samplers from `sampler` on: each death closes its scope and starts another after the next pause;
         * a sampler that lived `healthyMs` gives the pauses back. When they are spent, nvidia-smi, started, for good.
         */
        const follow = Effect.fnUntraced(function* (sampler: Extract<Source, { kind: 'nvml' }>) {
          let live = sampler;
          let used = 0;
          while (true) {
            const startedAt = yield* Clock.currentTimeMillis;
            yield* live.reader.died;
            yield* Metric.update(MonitorMetrics.nvmlDeaths, 1);
            yield* Scope.close(live.scope, Exit.void);
            if ((yield* Clock.currentTimeMillis) - startedAt >= healthyMs) used = 0;
            let next = Option.none<Source>();
            while (Option.isNone(next) && used < delays.length) {
              const pause = delays[used] ?? Duration.zero;
              used++;
              yield* Effect.logWarning(
                `the NVML sampler stopped: starting it again in ${Duration.format(pause)} (${used}/${delays.length})`,
              );
              yield* Effect.sleep(pause);
              next = yield* tryNvml;
            }
            if (Option.isNone(next) || next.value.kind !== 'nvml') break;
            yield* Metric.update(MonitorMetrics.nvmlRestarts, 1);
            live = next.value;
            yield* switchTo(live);
          }
          yield* Effect.logWarning('the NVML sampler keeps stopping: NVIDIA cards read by nvidia-smi from now on');
          const fallback = yield* smiReader;
          yield* switchTo({ kind: 'nvidia-smi', reader: fallback });
          yield* fallback.start;
        });

        const cards = yield* discoverAmdCards(options.drmRoot === undefined ? {} : { drmRoot: options.drmRoot });
        const procSampler = yield* makeProcSampler();
        const held = yield* Ref.make<Held>({ system: Option.none(), disk: Option.none() });
        const lock = yield* Semaphore.make(1);

        /** The system collector on: its perf in a scope of its own, forked from the programs'. */
        const systemOn = Effect.fnUntraced(function* (intervalMs: number) {
          const sampler = yield* makeSystemSampler();
          // Last: nothing can fail once perf runs. A start that dies stops what it started.
          const own = yield* Scope.fork(programs);
          const memBw = yield* makeMemBandwidth({
            bin: options.perfBin,
            intervalMs,
            retryAfter: options.perfRetryAfter,
          }).pipe(
            Scope.provide(own),
            Effect.onError(() => Scope.close(own, Exit.void)),
          );
          return { sample: Effect.provideContext(sampler.sample, context), memBw, scope: own } satisfies SystemOn;
        });

        /** The disk collector on: the disks listed now. */
        const diskOn = Effect.gen(function* () {
          const sampler = yield* makeDiskSampler({ disks: yield* physicalDisks() });
          return {
            sample: (modelDisk) => Effect.provideContext(sampler.sample(modelDisk), context),
            resolveModelDisk: (file) => Effect.provideContext(resolveModelDisk(file), context),
          } satisfies DiskSource;
        });

        /** One change: uninterruptible, so no perf runs that the state does not name. */
        const apply = Effect.fnUntraced(
          function* (settings: CollectorSettings) {
            yield* nvidia.configure({ intervalMs: settings.pollIntervalMs, needs: gpuNeeds(settings.hiddenGpus) });
            const { system, disk } = yield* Ref.get(held);
            if (!settings.collectors.system && Option.isSome(system)) {
              // Out of the state first: a reader sees it off before its perf stops.
              yield* Ref.update(held, (h) => ({ ...h, system: Option.none() }));
              yield* Scope.close(system.value.scope, Exit.void);
            } else if (settings.collectors.system && Option.isNone(system)) {
              const on = yield* systemOn(settings.pollIntervalMs);
              yield* Ref.update(held, (h) => ({ ...h, system: Option.some(on) }));
            } else if (Option.isSome(system)) {
              yield* system.value.memBw.configure(settings.pollIntervalMs);
            }
            if (!settings.collectors.disk) {
              yield* Ref.update(held, (h) => ({ ...h, disk: Option.none() }));
            } else if (Option.isNone(disk)) {
              const on = yield* diskOn;
              yield* Ref.update(held, (h) => ({ ...h, disk: Option.some(on) }));
            }
          },
          Effect.provideContext(context),
          Semaphore.withPermits(lock, 1),
          Effect.uninterruptible,
        );

        yield* apply(initial);
        if (Option.isSome(smi)) yield* smi.value.start;
        const started = yield* Ref.get(current);
        // In the layer's scope, after the programs': interrupted first at the end, so no stop reads as a death.
        if (started.kind === 'nvml') yield* Effect.forkIn(Effect.provideContext(follow(started), context), scope);

        const configure = Effect.fn('Collectors.configure')(function* (settings: CollectorSettings) {
          // In a fiber of the layer's scope: a caller that goes away stops waiting, the change runs to its end.
          return yield* Effect.uninterruptibleMask((restore) =>
            Effect.flatMap(Effect.forkIn(apply(settings), scope, { startImmediately: true }), (fiber) =>
              restore(Fiber.join(fiber)),
            ),
          ).pipe(
            Effect.catchDefect((defect) => Effect.fail(CollectorsNotApplied.make({ message: messageOf(defect) }))),
          );
        });

        return Collectors.of({
          nvidia,
          nvidiaSource: Effect.map(Ref.get(current), (s) => s.kind),
          nvmlSystem: Effect.flatMap(Ref.get(current), (s) =>
            s.kind === 'nvml' ? s.reader.system : Effect.succeed(null),
          ),
          amd: {
            cards,
            read: (card) => Effect.provideContext(readAmdCard(card), context),
            procVram: (pid, skipNodes) => Effect.provideContext(readProcAmdVram(pid, { skipNodes }), context),
            suspended: (card) => Effect.provideContext(isRuntimeSuspended(card), context),
          },
          proc: (pid) => Effect.provideContext(procSampler.sample(pid), context),
          system: Ref.get(held).pipe(
            Effect.map((h) => Option.map(h.system, (s): SystemSource => ({ sample: s.sample, memBw: s.memBw }))),
          ),
          disk: Ref.get(held).pipe(Effect.map((h) => h.disk)),
          configure,
        });
      }),
    );

  /**
   * The collectors from the stored settings, `LLAMA_WEBUI_NVML_LIB` (else the system's library) and
   * `LLAMA_WEBUI_NVIDIA_SMI` (else `nvidia-smi`); an empty variable counts as unset.
   */
  static readonly layer: Layer.Layer<
    Collectors,
    Config.ConfigError,
    SettingsRepo | ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path | PciIds
  > = Layer.unwrap(
    Effect.gen(function* () {
      const initial = yield* (yield* SettingsRepo).get;
      const env = yield* Config.all({
        nvmlLib: Config.option(Config.String('LLAMA_WEBUI_NVML_LIB')),
        nvidiaSmi: Config.String('LLAMA_WEBUI_NVIDIA_SMI').pipe(Config.withDefault('nvidia-smi')),
      });
      return Collectors.layerWith({ initial, ...env });
    }),
  );
}
