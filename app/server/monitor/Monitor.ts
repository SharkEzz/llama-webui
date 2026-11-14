import {
  type HistoryDump,
  type NvidiaSource,
  type ServerState,
  type Settings,
  type Snapshot,
  stateHost,
} from '@llama-webui/shared';
import {
  Cause,
  Clock,
  Config,
  Context,
  Duration,
  Effect,
  Fiber,
  type FileSystem,
  Layer,
  Option,
  Path,
  Predicate,
  Queue,
  Ref,
  Semaphore,
} from 'effect';
import type { ChildProcessSpawner } from 'effect/process';
import { Collectors, type CollectorsNotApplied, type DiskSource } from '../collectors/Collectors.ts';
import type { NvmlSystem } from '../collectors/nvml/protocol.ts';
import { homeDir } from '../config/Home.ts';
import type { PciIds } from '../hardware/PciIds.ts';
import type { LlamaHttp } from '../llama/LlamaHttp.ts';
import { readLlama, type Target } from '../llama/probes.ts';
import { ProfilesRepo } from '../profiles/ProfilesRepo.ts';
import { SettingsRepo } from '../settings/SettingsRepo.ts';
import { profilePaths } from '../supervisor/command.ts';
import { Supervisor } from '../supervisor/Supervisor.ts';
import { WsHub } from '../ws/WsHub.ts';
import { collectGpus } from './gpus.ts';
import { History, historyPoints } from './History.ts';
import { beginTick, endTick, initialMemory, type TickMemory, type TickReading } from './tick.ts';

/** The settings the monitor follows. */
export type MonitorSettings = Pick<Settings, 'collectors' | 'pollIntervalMs' | 'historySeconds' | 'hiddenGpus'>;

/** Where the active server listens, and its pid when known; none while no server is active. */
const activeOf = (state: ServerState): Option.Option<{ readonly target: Target; readonly pid: number | null }> => {
  switch (state.kind) {
    case 'starting':
    case 'ready':
    case 'stopping':
      return Option.some({ target: { host: stateHost(state), port: state.port }, pid: state.pid });
    case 'external':
      return Option.some({ target: { port: state.port }, pid: state.pid });
    default:
      return Option.none();
  }
};

const historyOf = (settings: MonitorSettings) =>
  new History(historyPoints(settings.historySeconds, settings.pollIntervalMs), settings.pollIntervalMs);

/** The settings in force and the history they shape: they change together. */
interface Held {
  readonly settings: MonitorSettings;
  readonly history: History;
}

/** The model disk of a profile: found (`disk`), or not yet, and when the last lookup ended. */
interface ModelDisk {
  readonly disk: string | null;
  readonly at: number;
  readonly pending: boolean;
}

/** A read that dies gives `fallback`: one broken reader leaves its part of the tick empty, not the whole tick. */
const orElse =
  <B>(fallback: B) =>
  <A>(self: Effect.Effect<A>): Effect.Effect<A | B> =>
    Effect.catchDefect(self, () => Effect.succeed(fallback));

/**
 * The monitoring: one tick every `pollIntervalMs`, whether clients are connected or not. A tick reads llama-server,
 * the cards, its process, perf, the machine and the disks, appends one point to every series of the history and
 * publishes its snapshot (`snapshot` on `/ws`).
 */
export class Monitor extends Context.Service<
  Monitor,
  {
    /** The last tick's snapshot; null before the first one. */
    readonly latest: Effect.Effect<Snapshot | null>;
    readonly history: Effect.Effect<HistoryDump>;
    /** The NVIDIA source chosen at startup. */
    readonly nvidiaSource: NvidiaSource;
    /** The driver's versions NVML reports; null with nvidia-smi or before NVML's first sample. */
    readonly nvmlSystem: Effect.Effect<NvmlSystem | null>;
    /**
     * Follows the settings: the collectors first; only once they accepted them do the settings become current, the
     * history is resized (its newest points kept) when its length or the interval changed, and the wait for the next
     * tick follows the new interval.
     */
    readonly configure: (settings: MonitorSettings) => Effect.Effect<void, CollectorsNotApplied>;
  }
>()('@llama-webui/app/server/monitor/Monitor') {
  /**
   * The monitor on the collectors and the stored settings: a fiber of the layer's scope ticks at once, without holding
   * the start of the app, then `pollIntervalMs` after the start of the previous tick (at once when it took longer),
   * one tick at a time. With nvidia-smi, llama-server's VRAM per card is refreshed and awaited on the first tick of a
   * pid, then in the background every `appsEvery` ticks. The model disk of a profile is looked up in the background,
   * again `modelDiskRetry` after a miss. A tick that fails is logged and the next one still comes.
   */
  static readonly layerWith = (options: {
    readonly modelDiskRetry: Duration.Input;
    readonly appsEvery: number;
  }): Layer.Layer<
    Monitor,
    never,
    Collectors | Supervisor | SettingsRepo | ProfilesRepo | WsHub | LlamaHttp | Path.Path
  > =>
    Layer.effect(
      Monitor,
      Effect.gen(function* () {
        const collectors = yield* Collectors;
        const supervisor = yield* Supervisor;
        const profiles = yield* ProfilesRepo;
        const hub = yield* WsHub;
        const path = yield* Path.Path;
        const context = yield* Effect.context<LlamaHttp>();
        const scope = yield* Effect.scope;
        const retryMs = Duration.toMillis(Duration.fromInputUnsafe(options.modelDiskRetry));

        const initial = yield* (yield* SettingsRepo).get;
        const held = yield* Ref.make<Held>({ settings: initial, history: historyOf(initial) });
        const memory = yield* Ref.make<TickMemory>(initialMemory);
        const latest = yield* Ref.make<Snapshot | null>(null);
        const modelDisks = yield* Ref.make<ReadonlyMap<number, ModelDisk>>(new Map());
        /** Offered when the interval changes: the wait for the next tick starts over with it. */
        const wake = yield* Queue.sliding<void>(1);
        const lock = yield* Semaphore.make(1);

        const setModelDisk = (id: number, entry: ModelDisk) =>
          Ref.update(modelDisks, (known) => new Map(known).set(id, entry));

        /** The disk that holds the model of profile `id`, looked up once; none for a missing profile or disk. */
        const lookUpModelDisk = (id: number, disk: DiskSource) =>
          Effect.gen(function* () {
            const profile = yield* profiles.get(id);
            const home = yield* homeDir;
            const { model } = profilePaths({ profile, home, cwd: path.resolve('.'), path });
            const found = yield* disk.resolveModelDisk(model);
            return Option.getOrNull(found);
          }).pipe(
            Effect.orElseSucceed(() => null),
            orElse(null),
            Effect.flatMap((found) =>
              Effect.flatMap(Clock.currentTimeMillis, (at) => setModelDisk(id, { disk: found, at, pending: false })),
            ),
          );

        /**
         * The model disk of the server's profile as known now: null for an external or crashed server, with the disk
         * collector off, and until a lookup found it. A lookup runs in a fiber of the layer's scope, never awaited: a
         * stat on a dead mount must never hold a tick.
         */
        const modelDiskFor = (state: ServerState, disk: Option.Option<DiskSource>) =>
          Effect.gen(function* () {
            if (Option.isNone(disk) || !('profileId' in state) || state.kind === 'crashed') return null;
            const id = state.profileId;
            const now = yield* Clock.currentTimeMillis;
            const known = (yield* Ref.get(modelDisks)).get(id);
            const due = known === undefined || (known.disk === null && !known.pending && now - known.at >= retryMs);
            if (due) {
              yield* setModelDisk(id, { disk: null, at: now, pending: true });
              yield* Effect.forkIn(lookUpModelDisk(id, disk.value), scope);
            }
            return known?.disk ?? null;
          });

        /** The cards, after a refresh of llama-server's VRAM per card when one is due. */
        const gpusOf = (pid: number | null, ticksForPid: number, hiddenGpus: ReadonlyArray<string>) =>
          Effect.gen(function* () {
            if (pid !== null) {
              if (ticksForPid === 1) yield* collectors.nvidia.refreshApps;
              else if (ticksForPid % options.appsEvery === 0)
                yield* Effect.forkIn(collectors.nvidia.refreshApps, scope);
            }
            return yield* collectGpus({ collectors, pid, hiddenGpus });
          });

        const tick = Effect.gen(function* () {
          const { settings } = yield* Ref.get(held);
          const state = yield* supervisor.state;
          const active = activeOf(state);
          const pid = Option.match(active, { onNone: () => null, onSome: (a) => a.pid });
          const before = yield* Ref.get(memory);
          const begun = beginTick(before, pid, Option.isSome(active));
          yield* Ref.set(memory, begun);
          const system = yield* collectors.system;
          const disk = yield* collectors.disk;
          if (Option.isSome(system)) yield* system.value.memBw.setPid(pid);
          const modelDisk = yield* modelDiskFor(state, disk);
          const at = yield* Clock.currentTimeMillis;

          const none = Effect.succeed(null);
          const [raw, allGpus, proc, dramBps, systemSample, memBw, diskSample] = yield* Effect.all(
            [
              Option.match(active, {
                onNone: () => none,
                onSome: (a) => readLlama(a.target).pipe(Effect.provideContext(context), orElse(null)),
              }),
              gpusOf(pid, begun.ticksForPid, settings.hiddenGpus).pipe(orElse([])),
              pid === null ? none : collectors.proc(pid).pipe(Effect.map(Option.getOrNull), orElse(null)),
              Option.isSome(active) && Option.isSome(system) ? system.value.memBw.procSample.pipe(orElse(null)) : none,
              Option.match(system, { onNone: () => none, onSome: (s) => s.sample.pipe(orElse(null)) }),
              Option.match(system, { onNone: () => none, onSome: (s) => s.memBw.sample.pipe(orElse(null)) }),
              Option.match(disk, { onNone: () => none, onSome: (d) => d.sample(modelDisk).pipe(orElse(null)) }),
            ],
            { concurrency: 'unbounded' },
          );

          const reading: TickReading = {
            at,
            active: Option.isSome(active),
            pid,
            raw,
            allGpus,
            proc,
            dramBps,
            system: Option.as(system, systemSample),
            disk: Option.as(disk, diskSample),
            memBw,
          };
          // In one step with the history it fills: a resize never lands in the middle of a tick.
          const done = yield* Ref.modify(held, (h) => [endTick(begun, h.history, reading), h]);
          yield* Ref.set(memory, done.memory);
          yield* Ref.set(latest, done.snapshot);
          yield* hub.publish({ type: 'snapshot', payload: done.snapshot });
        }).pipe(Effect.withSpan('Monitor.tick'));

        /** Until `pollIntervalMs` after `startedAt`, the interval read again whenever it changes. */
        const waitAfter = (startedAt: number): Effect.Effect<void> =>
          Effect.gen(function* () {
            const { settings } = yield* Ref.get(held);
            const remaining = startedAt + settings.pollIntervalMs - (yield* Clock.currentTimeMillis);
            if (remaining <= 0) return;
            const changed = yield* Queue.take(wake).pipe(
              Effect.as(true),
              Effect.timeoutOrElse({ duration: remaining, orElse: () => Effect.succeed(false) }),
            );
            if (changed) yield* waitAfter(startedAt);
          });

        const round = Effect.gen(function* () {
          const startedAt = yield* Clock.currentTimeMillis;
          yield* tick.pipe(
            Effect.catchCauseIf(Predicate.not(Cause.hasInterruptsOnly), (cause) =>
              Effect.logError('monitoring tick', cause),
            ),
          );
          yield* waitAfter(startedAt);
        });
        yield* Effect.forkIn(Effect.forever(round), scope);

        const apply = (next: MonitorSettings) =>
          Effect.gen(function* () {
            yield* collectors.configure(next);
            const intervalChanged = yield* Ref.modify(held, (h): readonly [boolean, Held] => {
              const before = h.settings;
              const reshaped =
                before.historySeconds !== next.historySeconds || before.pollIntervalMs !== next.pollIntervalMs;
              const history = reshaped
                ? h.history.resized(historyPoints(next.historySeconds, next.pollIntervalMs), next.pollIntervalMs)
                : h.history;
              return [before.pollIntervalMs !== next.pollIntervalMs, { settings: next, history }];
            });
            if (intervalChanged) yield* Queue.offer(wake, undefined);
          }).pipe(Semaphore.withPermits(lock, 1));

        const configure = Effect.fn('Monitor.configure')(function* (next: MonitorSettings) {
          // In a fiber of the layer's scope: a caller that goes away stops waiting, the change runs to its end.
          return yield* Effect.uninterruptibleMask((restore) =>
            Effect.flatMap(Effect.forkIn(apply(next), scope, { startImmediately: true }), (fiber) =>
              restore(Fiber.join(fiber)),
            ),
          );
        });

        return Monitor.of({
          latest: Ref.get(latest),
          history: Effect.flatMap(Ref.get(held), (h) => h.history.dump()),
          nvidiaSource: collectors.nvidiaSource,
          nvmlSystem: collectors.nvmlSystem,
          configure,
        });
      }),
    );

  /**
   * The monitor without collectors and without a fiber (the contract suite): no snapshot, an empty history, `nvml`
   * as the source, no NVML system, every settings change accepted.
   */
  static readonly layerStub: Layer.Layer<Monitor> = Layer.succeed(
    Monitor,
    Monitor.of({
      latest: Effect.succeed(null),
      history: Effect.succeed({ intervalMs: 1000, capacity: 0, at: 0, times: [], series: {} }),
      nvidiaSource: 'nvml',
      nvmlSystem: Effect.succeed(null),
      configure: () => Effect.void,
    }),
  );

  /**
   * `LLAMA_WEBUI_TEST_MONITOR=stub` gives the stub; otherwise the monitor on the collectors built for it, which end
   * right after it: the model disk retried every 30 s, the VRAM per card refreshed every 5 ticks.
   */
  static readonly layer: Layer.Layer<
    Monitor,
    Config.ConfigError,
    | Supervisor
    | SettingsRepo
    | ProfilesRepo
    | WsHub
    | LlamaHttp
    | ChildProcessSpawner.ChildProcessSpawner
    | FileSystem.FileSystem
    | Path.Path
    | PciIds
  > = Layer.unwrap(
    Effect.gen(function* () {
      const mode = yield* Config.option(Config.String('LLAMA_WEBUI_TEST_MONITOR'));
      return Option.contains(mode, 'stub')
        ? Monitor.layerStub
        : Monitor.layerWith({ modelDiskRetry: '30 seconds', appsEvery: 5 }).pipe(Layer.provide(Collectors.layer));
    }),
  );
}
