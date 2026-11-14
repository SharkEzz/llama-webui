import type { DiskSample, GpuReading, NvidiaSource, Settings, SystemSample } from '@llama-webui/shared';
import {
  Config,
  Context,
  type Duration,
  Effect,
  Exit,
  Fiber,
  type FileSystem,
  Layer,
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
import { SettingsRepo } from '../settings/SettingsRepo.ts';
import { type AmdCard, discoverAmdCards, isRuntimeSuspended, readAmdCard, readProcAmdVram } from './amdgpu.ts';
import { makeDiskSampler, physicalDisks, resolveModelDisk } from './disk.ts';
import { gpuNeeds, type NvidiaReader } from './gpu.ts';
import { type MemBandwidthSampler, makeMemBandwidth } from './membw.ts';
import { makeNvidiaSmi, type NvidiaSmi } from './nvidia.ts';
import { startNvml } from './nvml/Nvml.ts';
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

/**
 * The hardware collectors: NVIDIA through NVML in a child process, else nvidia-smi (chosen once, at startup), the AMD
 * cards through sysfs (discovered once), llama-server's process, and CPU, memory, perf and the disks, each behind the
 * switch of its setting. `configure` follows the settings, except `collectors.nvml`, read at startup only.
 */
export class Collectors extends Context.Service<
  Collectors,
  {
    readonly nvidia: NvidiaReader;
    /** The NVIDIA source chosen at startup. */
    readonly nvidiaSource: NvidiaSource;
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
   * up, `nvidiaSmi` is the source, started once the settings are applied. `appsTimeout` bounds nvidia-smi's
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
    readonly appsTimeout?: Duration.Input;
    readonly perfRetryAfter?: Duration.Input;
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

        const nvml = initial.collectors.nvml
          ? yield* startNvml({
              intervalMs: initial.pollIntervalMs,
              needs: gpuNeeds(initial.hiddenGpus),
              lib: options.nvmlLib,
              command: options.nvmlCommand,
              readyTimeout: options.readyTimeout,
            }).pipe(Scope.provide(programs))
          : Option.none();
        // nvidia-smi only when NVML did not come up.
        const { nvidia, smi } = yield* Option.match(nvml, {
          onSome: (reader) => Effect.succeed({ nvidia: reader as NvidiaReader, smi: Option.none<NvidiaSmi>() }),
          onNone: () =>
            makeNvidiaSmi({
              bin: options.nvidiaSmi,
              intervalMs: initial.pollIntervalMs,
              appsTimeout: options.appsTimeout,
            }).pipe(
              Scope.provide(programs),
              Effect.map((reader) => ({ nvidia: reader as NvidiaReader, smi: Option.some(reader) })),
            ),
        });

        const cards = yield* discoverAmdCards();
        const procSampler = yield* makeProcSampler();
        const held = yield* Ref.make<Held>({ system: Option.none(), disk: Option.none() });
        const lock = yield* Semaphore.make(1);

        /** The system collector on: its perf in a scope of its own, forked from the programs'. */
        const systemOn = (intervalMs: number) =>
          Effect.gen(function* () {
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
        const apply = (settings: CollectorSettings) =>
          Effect.gen(function* () {
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
          }).pipe(Effect.provideContext(context), Semaphore.withPermits(lock, 1), Effect.uninterruptible);

        yield* apply(initial);
        if (Option.isSome(smi)) yield* smi.value.start;

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
          nvidiaSource: Option.isSome(nvml) ? 'nvml' : 'nvidia-smi',
          nvmlSystem: Option.match(nvml, { onNone: () => Effect.succeed(null), onSome: (n) => n.system }),
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
