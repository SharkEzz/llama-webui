import {
  BenchFileMissing,
  type BenchLive,
  type BenchRun,
  BenchRunning,
  type BenchSpec,
  type ExternalServerRunning,
  type BenchHardware as Hardware,
  NothingToResume,
  NothingToValidate,
  RunNotFound,
  RunNotRunning,
  rankRuns,
  type ServerRunning,
  type ServerStopTooSlow,
  type Sweep,
  type SweepLive,
  SweepNotFound,
  SweepNotRunning,
  SweepStillRunning,
  sweepCtx,
  withCtx,
} from '@llama-webui/shared';
import {
  Array as Arr,
  Cause,
  Clock,
  Context,
  Deferred,
  Duration,
  Effect,
  Fiber,
  FileSystem,
  Layer,
  Option,
  type Path,
  Ref,
  Scope,
  SynchronizedRef,
} from 'effect';
import type { ChildProcessSpawner } from 'effect/process';
import type { LlamaHttp } from '../llama/LlamaHttp.ts';
import type { LogRing } from '../logs/LogRing.ts';
import { Monitor } from '../monitor/Monitor.ts';
import { ProfilesRepo } from '../profiles/ProfilesRepo.ts';
import { Shutdown } from '../runtime/Shutdown.ts';
import { SettingsRepo } from '../settings/SettingsRepo.ts';
import { type BuiltCommand, buildCommand } from '../supervisor/command.ts';
import type { Supervisor } from '../supervisor/Supervisor.ts';
import { WsHub } from '../ws/WsHub.ts';
import { BenchHardware } from './BenchHardware.ts';
import { BenchRunsRepo, type QueuedItem } from './BenchRunsRepo.ts';
import { commandOf, type ExecResult, execute } from './execute.ts';
import { makeGate } from './gate.ts';
import { SweepsRepo } from './SweepsRepo.ts';

/** The error of a run left running when llama-webui stopped. */
const INTERRUPTED = 'interrupted (llama-webui stopped)';
const NO_HARDWARE: Hardware = { cpu: '', gpus: [], build: null };

/** The model and the projector a run or a sweep reads. */
export type RunFiles = Pick<BenchSpec, 'modelPath' | 'mmprojPath'>;

/** What refuses a start: the runner busy, a file missing, or the gate. */
export type StartError = BenchRunning | BenchFileMissing | ServerStopTooSlow | ExternalServerRunning | ServerRunning;

/** The run being executed. */
interface Current {
  readonly runId: number;
  readonly sweepId: number | null;
  readonly files: RunFiles;
  readonly cancel: Deferred.Deferred<void>;
  readonly cancelled: boolean;
  /** Its result is saved; only the release of the gate is left. */
  readonly finished: boolean;
  readonly live: BenchLive;
}

/** The running sweep. */
interface Running {
  readonly id: number;
  readonly files: RunFiles;
  readonly cancelled: boolean;
}

interface State {
  /** A request between its acceptance and the start of its run or sweep. */
  readonly claimed: boolean;
  readonly current: Option.Option<Current>;
  readonly sweep: Option.Option<Running>;
  readonly sweepLive: Option.Option<SweepLive>;
  /** The forked one-off run or sweep loop. */
  readonly work: Option.Option<Fiber.Fiber<void>>;
  /** llama-webui is stopping: nothing is started, written or published any more. */
  readonly closing: boolean;
}

const IDLE: State = {
  claimed: false,
  current: Option.none(),
  sweep: Option.none(),
  sweepLive: Option.none(),
  work: Option.none(),
  closing: false,
};

const filesOf = (files: RunFiles): ReadonlyArray<string> =>
  files.mmprojPath === null || files.mmprojPath === '' ? [files.modelPath] : [files.modelPath, files.mmprojPath];

/**
 * A throttle on the clock: `run(lines, publish)` publishes at once when `lines` is false (a phase, a step, a cancel),
 * and a change of lines only when the last publication is `every` old (llama-server writes hundreds of lines while it
 * loads); a dropped change is not sent later, the next one carries its lines.
 */
export const makeThrottle = Effect.fn('BenchRunner.makeThrottle')(function* (every: Duration.Input) {
  const ms = Duration.toMillis(Duration.fromInputUnsafe(every));
  const last = yield* Ref.make(Number.NEGATIVE_INFINITY);
  return Effect.fnUntraced(function* (lines: boolean, publish: Effect.Effect<void>) {
    const now = yield* Clock.currentTimeMillis;
    const go = yield* Ref.modify(last, (at): [boolean, number] =>
      !lines || now - at >= ms ? [true, now] : [false, at],
    );
    if (go) yield* publish;
  });
});

/**
 * The benchmarks: one one-off run or one sweep at a time, run in the background, with the managed llama-server stopped
 * during them (the gate) and restarted after. Its state sits in one `SynchronizedRef`; its runs and sweep loop are
 * forked in its layer's scope. It publishes `bench-progress`, `bench-run`, `sweep-progress` and `sweep`.
 */
export class BenchRunner extends Context.Service<
  BenchRunner,
  {
    /** A request being accepted, a run, a sweep, or the gate held. */
    readonly busy: Effect.Effect<boolean>;
    readonly live: Effect.Effect<BenchLive | null>;
    readonly sweepLive: Effect.Effect<SweepLive | null>;
    /** The model and projector of the current run and of the running sweep. */
    readonly files: Effect.Effect<ReadonlyArray<string>>;
    /** A one-off run: checked, the gate taken, saved `running` and started in the background; the saved run. */
    readonly start: (spec: BenchSpec, options: { readonly stopServer: boolean }) => Effect.Effect<BenchRun, StartError>;
    /**
     * The one entry of a sweep run. Under the claim: `files` checked, then `check` (its refusals leave nothing stopped),
     * then the gate taken and `prepare` run (it writes the rows, gives the sweep's id; its failure releases the gate);
     * then the sweep is set `running` and its loop started in the background.
     */
    readonly startSweep: <E1 = never, E2 = never>(options: {
      readonly files: RunFiles;
      readonly stopServer: boolean;
      readonly check?: Effect.Effect<void, E1>;
      readonly prepare: Effect.Effect<number, E2>;
    }) => Effect.Effect<Sweep, StartError | E1 | E2>;
    /** Runs the interrupted and queued items of a sweep that is not running. */
    readonly resume: (
      id: number,
      options: { readonly stopServer: boolean },
    ) => Effect.Effect<Sweep, StartError | SweepNotFound | SweepStillRunning | NothingToResume>;
    /** Validates the `n` best explored items with llama-server runs (and finishes the interrupted ones). */
    readonly validate: (
      id: number,
      options: { readonly n: number; readonly stopServer: boolean },
    ) => Effect.Effect<Sweep, StartError | SweepNotFound | SweepStillRunning | NothingToValidate>;
    /** Cancels the current run when it has this id; in a sweep, the loop moves on to the next item. */
    readonly cancel: (id: number) => Effect.Effect<void, RunNotFound | RunNotRunning>;
    /** Cancels the running sweep: its queue `cancelled`, its current run stopped, the server restarted. */
    readonly cancelSweep: (id: number) => Effect.Effect<void, SweepNotFound | SweepNotRunning>;
  }
>()('@llama-webui/app/server/bench/BenchRunner') {
  /**
   * The runner. `killTimeout`: from SIGTERM to SIGKILL on a cancel; `pause`: between two sweep items;
   * `stoppingTimeout`: the wait for a stop in progress when the gate is taken; `liveThrottle`: the most frequent
   * `bench-progress` of new lines. At its build, the runs and sweeps left `running` become `interrupted`. Its shutdown
   * step interrupts the work, saves the current run and the running sweep `interrupted` and publishes them, then no
   * live (`bench-progress` and `sweep-progress` null), before the hub closes; it does not restart llama-server.
   */
  static readonly layerWith = (options: {
    readonly killTimeout: Duration.Input;
    readonly pause: Duration.Input;
    readonly stoppingTimeout: Duration.Input;
    readonly liveThrottle: Duration.Input;
  }): Layer.Layer<
    BenchRunner,
    never,
    | BenchRunsRepo
    | SweepsRepo
    | BenchHardware
    | Supervisor
    | ProfilesRepo
    | SettingsRepo
    | Monitor
    | LogRing
    | WsHub
    | LlamaHttp
    | Shutdown
    | FileSystem.FileSystem
    | Path.Path
    | ChildProcessSpawner.ChildProcessSpawner
  > =>
    Layer.effect(
      BenchRunner,
      Effect.gen(function* () {
        const runs = yield* BenchRunsRepo;
        const sweeps = yield* SweepsRepo;
        const hardwareOf = yield* BenchHardware;
        const monitor = yield* Monitor;
        const hub = yield* WsHub;
        const shutdown = yield* Shutdown;
        const profiles = yield* ProfilesRepo;
        const settingsRepo = yield* SettingsRepo;
        const fs = yield* FileSystem.FileSystem;
        const scope = yield* Scope.Scope;
        const context = yield* Effect.context<
          | SettingsRepo
          | ProfilesRepo
          | LogRing
          | LlamaHttp
          | FileSystem.FileSystem
          | Path.Path
          | ChildProcessSpawner.ChildProcessSpawner
        >();

        // The last run's orphans, before any request is served.
        yield* runs.stopOrphans;
        yield* sweeps.stopOrphans;

        const gate = yield* makeGate({ stoppingTimeout: options.stoppingTimeout });
        const state = yield* SynchronizedRef.make<State>(IDLE);
        const throttle = yield* makeThrottle(options.liveThrottle);

        const closing = Effect.map(SynchronizedRef.get(state), (s) => s.closing);
        /** Publishes unless llama-webui is stopping. */
        const publish = (message: Parameters<typeof hub.publish>[0]) =>
          Effect.flatMap(closing, (stopping) => (stopping ? Effect.void : hub.publish(message)));
        const publishLive = (live: BenchLive | null) => publish({ type: 'bench-progress', payload: live });
        const publishSweep = (id: number) =>
          Effect.flatMap(sweeps.get(id), (found) =>
            Option.isSome(found) ? publish({ type: 'sweep', payload: found.value }) : Effect.void,
          );
        const setSweepLive = Effect.fnUntraced(function* (live: Option.Option<SweepLive>) {
          yield* SynchronizedRef.update(state, (s) => ({ ...s, sweepLive: live }));
          yield* publish({ type: 'sweep-progress', payload: Option.getOrNull(live) });
        });

        const gpus = Effect.map(monitor.latest, (snapshot) => snapshot?.allGpus ?? []);
        const disk = Effect.map(monitor.latest, (snapshot) => snapshot?.disk?.model?.readBps ?? null);
        const hardwareNow = Effect.flatMap(gpus, hardwareOf.hardware);

        /** The command of the stopped server's profile as it is now (#39); none when it is gone or does not build. */
        const rebuild = Effect.fnUntraced(
          function* (stopped: BuiltCommand) {
            const profile = yield* profiles.get(stopped.profileId);
            const settings = yield* settingsRepo.get;
            return yield* buildCommand({ profile, settings });
          },
          Effect.provideContext(context),
          Effect.option,
        );

        const busy = Effect.gen(function* () {
          const s = yield* SynchronizedRef.get(state);
          if (s.claimed || Option.isSome(s.current) || Option.isSome(s.sweep)) return true;
          return yield* gate.held;
        });

        /** Claims the runner, or 409; the claim is released by the caller's `ensuring`. */
        const claim = SynchronizedRef.modifyEffect(state, (s) =>
          Effect.map(gate.held, (held): [boolean, State] =>
            s.closing || s.claimed || held || Option.isSome(s.current) || Option.isSome(s.sweep)
              ? [false, s]
              : [true, { ...s, claimed: true }],
          ),
        ).pipe(
          Effect.flatMap((claimed) =>
            claimed ? Effect.void : Effect.fail(BenchRunning.make({ message: 'A benchmark is running' })),
          ),
        );
        const unclaim = SynchronizedRef.update(state, (s) => ({ ...s, claimed: false }));

        const checkFiles = Effect.fnUntraced(function* (files: RunFiles) {
          const exists = (path: string) => fs.exists(path).pipe(Effect.orElseSucceed(() => false));
          if (!(yield* exists(files.modelPath)))
            return yield* BenchFileMissing.make({ message: `Model not found: ${files.modelPath}` });
          if (files.mmprojPath !== null && files.mmprojPath !== '' && !(yield* exists(files.mmprojPath)))
            return yield* BenchFileMissing.make({ message: `Projector not found: ${files.mmprojPath}` });
        });

        /**
         * Frees the gate after a start that did not go through, restarting a server it began to stop; not while the app
         * stops (a request interrupted by the shutdown restarts nothing).
         */
        const abandon = Effect.flatMap(closing, (stopping) => (stopping ? Effect.void : gate.release(rebuild))).pipe(
          Effect.ignore,
        );

        /** A run becomes the current one: its live published at once. */
        const begin = Effect.fnUntraced(function* (run: BenchRun, sweepId: number | null, files: RunFiles) {
          const cancel = yield* Deferred.make<void>();
          const stopping = yield* gate.stopping;
          const startedAt = yield* Clock.currentTimeMillis;
          const live: BenchLive = {
            runId: run.id,
            kind: run.kind,
            phase: stopping ? 'stopping-server' : 'loading',
            step: null,
            startedAt,
            lines: [],
          };
          const current: Current = { runId: run.id, sweepId, files, cancel, cancelled: false, finished: false, live };
          yield* SynchronizedRef.update(state, (s) => ({ ...s, current: Option.some(current) }));
          yield* publishLive(live);
          return current;
        });

        const updateCurrent = (runId: number, f: (current: Current) => Current) =>
          SynchronizedRef.update(state, (s) => ({
            ...s,
            current: Option.map(s.current, (c) => (c.runId === runId ? f(c) : c)),
          }));

        /** Executes the current run after the gate's stop, saves its result and publishes it. */
        const executed = Effect.fnUntraced(function* (current: Current, spec: BenchSpec, run: BenchRun) {
          const ready = yield* gate.ready.pipe(Effect.result);
          const result: ExecResult | { readonly status: 'failed'; readonly error: string } =
            ready._tag === 'Failure'
              ? { status: 'failed', error: `could not stop llama-server: ${ready.failure.message}` }
              : yield* execute({
                  run: { id: run.id, kind: run.kind, command: run.command },
                  spec,
                  startedAt: current.live.startedAt,
                  onLive: (live, lines) =>
                    updateCurrent(run.id, (c) => ({ ...c, live })).pipe(
                      Effect.andThen(throttle(lines, publishLive(live))),
                    ),
                  killTimeout: options.killTimeout,
                  cancel: current.cancel,
                  gpus,
                  disk,
                }).pipe(Effect.scoped, Effect.provideContext(context));
          const saved = yield* runs.finish(run.id, { error: null, ...result });
          yield* updateCurrent(run.id, (c) => ({ ...c, finished: true }));
          yield* publish({ type: 'bench-run', payload: saved });
          return saved;
        });

        /**
         * The gate released after a one-off run or a sweep: `restarting-server` shown while a stopped server comes
         * back; a failed restart appended to the last run's error and published; then no live.
         */
        const release = Effect.fnUntraced(function* (lastRun: Option.Option<number>) {
          const stopped = yield* gate.stoppedCommand;
          const s = yield* SynchronizedRef.get(state);
          if (Option.isSome(stopped) && Option.isSome(s.current)) {
            const live: BenchLive = { ...s.current.value.live, phase: 'restarting-server', step: null };
            yield* updateCurrent(s.current.value.runId, (c) => ({ ...c, live }));
            yield* publishLive(live);
          }
          const restarted = yield* gate.release(rebuild).pipe(Effect.result);
          if (restarted._tag === 'Failure' && Option.isSome(lastRun)) {
            const run = yield* runs.get(lastRun.value);
            if (Option.isSome(run)) {
              const previous = run.value.error;
              const error = previous === null ? restarted.failure.message : `${previous}; ${restarted.failure.message}`;
              const saved = yield* runs.finish(lastRun.value, { error });
              yield* publish({ type: 'bench-run', payload: saved });
            }
          }
          yield* SynchronizedRef.update(state, (st) => ({ ...st, current: Option.none() }));
          yield* publishLive(null);
        });

        const oneOff = Effect.fnUntraced(function* (current: Current, spec: BenchSpec, run: BenchRun) {
          yield* executed(current, spec, run);
          yield* release(Option.some(run.id));
          yield* SynchronizedRef.update(state, (s) => ({ ...s, work: Option.none() }));
        });

        /**
         * The end of a work that died on a defect (a failed SQL statement, a parser that throws), which nothing else
         * would undo: logged, then the current run saved `failed`, the running sweep `interrupted` (its queue stays
         * for a resume), the gate released (llama-server restarted, unless the app stops), the runner free, no live.
         * Each step on its own: one that fails too is logged and the next ones still run.
         */
        const crashed = Effect.fnUntraced(function* (cause: Cause.Cause<never>) {
          yield* Effect.logError('a benchmark stopped on a defect', cause);
          const step = <A>(effect: Effect.Effect<A>) =>
            effect.pipe(Effect.catchCause((failed) => Effect.logError('the end of a benchmark failed', failed)));
          const s = yield* SynchronizedRef.get(state);
          const defect = Cause.squash(cause);
          const current = Option.filter(s.current, (c) => !c.finished);
          if (Option.isSome(current)) {
            const now = yield* Clock.currentTimeMillis;
            yield* step(
              runs
                .finish(current.value.runId, {
                  status: 'failed',
                  error: `internal error: ${defect instanceof Error ? defect.message : String(defect)}`,
                  durationMs: now - current.value.live.startedAt,
                })
                .pipe(Effect.flatMap((saved) => publish({ type: 'bench-run', payload: saved }))),
            );
          }
          if (Option.isSome(s.sweep)) {
            yield* step(
              sweeps
                .setStatus(s.sweep.value.id, 'interrupted')
                .pipe(Effect.flatMap((sweep) => publish({ type: 'sweep', payload: sweep }))),
            );
          }
          yield* step(abandon);
          yield* SynchronizedRef.update(state, (st) => ({
            ...st,
            current: Option.none(),
            sweep: Option.none(),
            sweepLive: Option.none(),
            work: Option.none(),
          }));
          if (Option.isSome(s.current)) yield* step(publishLive(null));
          if (Option.isSome(s.sweepLive)) yield* step(publish({ type: 'sweep-progress', payload: null }));
        });

        /**
         * Forks `work` in the layer's scope and records it; done uninterruptibly with what made it. A work that dies
         * ends through `crashed`; an interrupted one is the shutdown step's, or the end of the layer.
         */
        const fork = Effect.fnUntraced(function* (work: Effect.Effect<void>) {
          const guarded = work.pipe(
            Effect.onError((cause) => (Cause.hasInterruptsOnly(cause) ? Effect.void : crashed(cause))),
          );
          const fiber = yield* Effect.forkIn(guarded, scope);
          yield* SynchronizedRef.update(state, (s) => ({ ...s, work: Option.some(fiber) }));
        });

        const start = Effect.fn('BenchRunner.start')(function* (
          spec: BenchSpec,
          request: { readonly stopServer: boolean },
        ) {
          yield* claim;
          return yield* Effect.gen(function* () {
            yield* checkFiles(spec);
            // `abandon` covers the acquire itself: an interruption right after the gate is taken still frees it.
            return yield* Effect.gen(function* () {
              yield* gate.acquire({ stopServer: request.stopServer });
              const command = yield* commandOf(spec).pipe(Effect.provideContext(context));
              const hardware = yield* hardwareNow;
              return yield* Effect.uninterruptible(
                Effect.gen(function* () {
                  const run = yield* runs.create({ spec, command: command.display, hardware, status: 'running' });
                  yield* publish({ type: 'bench-run', payload: run });
                  const current = yield* begin(run, null, spec);
                  yield* fork(oneOff(current, spec, run));
                  return run;
                }),
              );
            }).pipe(Effect.onError(() => abandon));
          }).pipe(Effect.ensuring(unclaim));
        });

        /** The best run of a sweep: among its validations if one succeeded, otherwise among its exploration. */
        const bestOf = Effect.fnUntraced(function* (sweep: Sweep) {
          const all = yield* runs.list({
            kind: Option.none(),
            status: Option.none(),
            modelPath: Option.none(),
            sweep: sweep.id,
            limit: Number.MAX_SAFE_INTEGER,
          });
          const validated = Arr.some(all, (r) => r.kind === 'server' && r.status === 'ok');
          const ranked = rankRuns(
            Arr.filter(all, (r) => r.kind === (validated ? 'server' : 'bench')),
            { preset: sweep.spec.preset, ctx: sweepCtx(sweep.spec) },
          );
          return Option.getOrNull(
            Option.flatMap(Arr.head(ranked), (top) => (top.rank === null ? Option.none() : Option.some(top.run.id))),
          );
        });

        /** One item: its command and hardware frozen, executed, saved. A failure (OOM included) does not stop the sweep. */
        const item = Effect.fnUntraced(function* (queued: BenchRun, sweepId: number) {
          const hardware = yield* hardwareNow.pipe(Effect.orElseSucceed(() => NO_HARDWARE));
          const command = yield* commandOf(queued.spec).pipe(Effect.provideContext(context));
          const run = yield* runs.begin(queued.id, { command: command.display, hardware });
          yield* publish({ type: 'bench-run', payload: run });
          const current = yield* begin(run, sweepId, queued.spec);
          return yield* executed(current, queued.spec, run);
        });

        const sweepCancelled = Effect.map(SynchronizedRef.get(state), (s) =>
          Option.exists(s.sweep, (sweep) => sweep.cancelled),
        );

        const loop = Effect.fnUntraced(function* (id: number) {
          let last = Option.none<number>();
          for (;;) {
            if (yield* sweepCancelled) break;
            const next = yield* runs.nextQueued(id);
            if (Option.isNone(next)) break;
            const found = yield* sweeps.get(id);
            const counts = Option.map(found, (sweep) => sweep.counts);
            const total = Option.match(counts, { onNone: () => 0, onSome: (c) => c.total });
            const queued = Option.match(counts, { onNone: () => 0, onSome: (c) => c.queued });
            yield* setSweepLive(
              Option.some({
                sweepId: id,
                runId: next.value.id,
                index: total - queued + 1,
                total,
                stage: next.value.kind === 'server' ? 'validate' : 'explore',
              }),
            );
            const done = yield* item(next.value, id);
            last = Option.some(done.id);
            yield* publishSweep(id);
            const after = yield* runs.nextQueued(id);
            const more = Option.isSome(after) && !(yield* sweepCancelled);
            if (more) {
              // The last item's live stays until the release (restarting-server); the others' ends here.
              yield* SynchronizedRef.update(state, (s) => ({ ...s, current: Option.none() }));
              yield* publishLive(null);
              yield* Effect.sleep(options.pause);
            }
          }
          const cancelled = yield* sweepCancelled;
          const sweep = yield* sweeps.get(id);
          const bestRunId = Option.isSome(sweep) ? yield* bestOf(sweep.value) : null;
          const finishedAt = yield* Clock.currentTimeMillis;
          const ended = yield* sweeps.setStatus(id, cancelled ? 'cancelled' : 'done', { bestRunId, finishedAt });
          yield* publish({ type: 'sweep', payload: ended });
          yield* release(last);
          yield* SynchronizedRef.update(state, (s) => ({ ...s, sweep: Option.none(), work: Option.none() }));
          yield* setSweepLive(Option.none());
        });

        const startSweep = <E1 = never, E2 = never>(request: {
          readonly files: RunFiles;
          readonly stopServer: boolean;
          readonly check?: Effect.Effect<void, E1>;
          readonly prepare: Effect.Effect<number, E2>;
        }): Effect.Effect<Sweep, StartError | E1 | E2> =>
          claim.pipe(
            Effect.andThen(
              Effect.gen(function* () {
                yield* checkFiles(request.files);
                if (request.check !== undefined) yield* request.check;
                return yield* Effect.gen(function* () {
                  yield* gate.acquire({ stopServer: request.stopServer });
                  const id = yield* request.prepare;
                  return yield* Effect.uninterruptible(
                    Effect.gen(function* () {
                      const sweep = yield* sweeps.setStatus(id, 'running', { finishedAt: null });
                      yield* SynchronizedRef.update(state, (s) => ({
                        ...s,
                        sweep: Option.some({ id, files: request.files, cancelled: false }),
                      }));
                      yield* publish({ type: 'sweep', payload: sweep });
                      yield* fork(loop(id));
                      return sweep;
                    }),
                  );
                }).pipe(Effect.onError(() => abandon));
              }).pipe(Effect.ensuring(unclaim)),
            ),
            Effect.withSpan('BenchRunner.startSweep'),
          );

        /** A sweep that is not running, or 404 / 409. */
        const idle = Effect.fnUntraced(function* (id: number) {
          const found = yield* sweeps.get(id);
          if (Option.isNone(found)) return yield* SweepNotFound.make({ message: 'Sweep not found' });
          if (found.value.status === 'running')
            return yield* SweepStillRunning.make({ message: 'This sweep is still running: cancel it first' });
          return found.value;
        });

        const itemsOf = (id: number) =>
          runs.list({
            kind: Option.none(),
            status: Option.none(),
            modelPath: Option.none(),
            sweep: id,
            limit: Number.MAX_SAFE_INTEGER,
          });

        const resume = Effect.fn('BenchRunner.resume')(function* (
          id: number,
          request: { readonly stopServer: boolean },
        ) {
          const sweep = yield* idle(id);
          return yield* startSweep({
            files: sweep.spec,
            stopServer: request.stopServer,
            check: Effect.gen(function* () {
              const items = yield* itemsOf(id);
              if (!Arr.some(items, (r) => r.status === 'interrupted' || r.status === 'queued'))
                return yield* NothingToResume.make({ message: 'Nothing to resume: no interrupted or queued item' });
            }),
            prepare: runs.requeueInterrupted(id).pipe(Effect.as(id)),
          });
        });

        const validate = Effect.fn('BenchRunner.validate')(function* (
          id: number,
          request: { readonly n: number; readonly stopServer: boolean },
        ) {
          const sweep = yield* idle(id);
          const items = yield* itemsOf(id);
          const explored = Arr.filter(items, (r) => r.kind === 'bench');
          const best = Arr.take(
            Arr.filter(
              rankRuns(explored, { preset: sweep.spec.preset, ctx: sweepCtx(sweep.spec) }),
              (x) => x.rank !== null,
            ),
            request.n,
          );
          if (!Arr.isReadonlyArrayNonEmpty(best))
            return yield* NothingToValidate.make({ message: 'No successful run to validate' });
          const { modelPath, mmprojPath, profileId, serverArgs, p, n, r } = sweep.spec;
          const queued = Arr.map(
            best,
            ({ run }): QueuedItem => ({
              spec: {
                kind: 'server',
                modelPath,
                mmprojPath,
                profileId,
                params: run.spec.params,
                // The context the sweep was planned at, not the model's full one (#24).
                serverArgs: withCtx(serverArgs, sweepCtx(sweep.spec)),
                p,
                n,
                r,
              },
              label: `validation · ${run.sweepLabel ?? 'base'}`,
              fit: run.fit ?? 'fits',
            }),
          );
          return yield* startSweep({
            files: sweep.spec,
            stopServer: request.stopServer,
            // An interrupted sweep: its interrupted items are requeued with the validation (nothing else would finish
            // them).
            prepare: Effect.gen(function* () {
              yield* runs.requeueInterrupted(id);
              yield* runs.enqueue(id, queued);
              return id;
            }),
          });
        });

        const cancel = Effect.fn('BenchRunner.cancel')(function* (id: number) {
          const taken = yield* SynchronizedRef.modify(state, (s): [Option.Option<Current>, State] => {
            const current = Option.filter(s.current, (c) => c.runId === id && !c.cancelled && !c.finished);
            return Option.isNone(current)
              ? [current, s]
              : [current, { ...s, current: Option.some({ ...current.value, cancelled: true }) }];
          });
          if (Option.isNone(taken)) {
            const found = yield* runs.get(id);
            if (Option.isNone(found)) return yield* RunNotFound.make({ message: 'Run not found' });
            return yield* RunNotRunning.make({ message: 'This run is not running' });
          }
          yield* Deferred.succeed(taken.value.cancel, undefined);
        });

        const cancelSweep = Effect.fn('BenchRunner.cancelSweep')(function* (id: number) {
          const taken = yield* SynchronizedRef.modify(state, (s): [Option.Option<Option.Option<Current>>, State] => {
            const sweep = Option.filter(s.sweep, (sw) => sw.id === id && !sw.cancelled);
            if (Option.isNone(sweep)) return [Option.none(), s];
            const current = Option.filter(s.current, (c) => !c.finished && !c.cancelled);
            return [
              Option.some(current),
              {
                ...s,
                sweep: Option.some({ ...sweep.value, cancelled: true }),
                current: Option.isSome(current) ? Option.some({ ...current.value, cancelled: true }) : s.current,
              },
            ];
          });
          if (Option.isNone(taken)) {
            const found = yield* sweeps.get(id);
            if (Option.isNone(found)) return yield* SweepNotFound.make({ message: 'Sweep not found' });
            return yield* SweepNotRunning.make({ message: 'This sweep is not running' });
          }
          yield* runs.cancelQueued(id);
          if (Option.isSome(taken.value)) yield* Deferred.succeed(taken.value.value.cancel, undefined);
          yield* publishSweep(id);
        });

        // Shutdown: the work interrupted (its child killed through its scope), then the current run and the running
        // sweep saved `interrupted` for the next start and published, then no live: the step runs before the hub
        // closes, so an open page sees the end. The work's own publications are silenced by `closing`; these go to
        // the hub directly. llama-server is not restarted.
        yield* shutdown.before(
          Effect.gen(function* () {
            const s = yield* SynchronizedRef.updateAndGet(state, (st) => ({ ...st, closing: true }));
            if (Option.isSome(s.work)) yield* Fiber.interrupt(s.work.value);
            const now = yield* Clock.currentTimeMillis;
            const current = Option.filter(s.current, (c) => !c.finished);
            if (Option.isSome(current)) {
              const run = yield* runs.get(current.value.runId);
              const saved = yield* runs.finish(current.value.runId, {
                status: 'interrupted',
                error: Option.getOrNull(Option.flatMap(run, (r) => Option.fromNullishOr(r.error))) ?? INTERRUPTED,
                durationMs: now - current.value.live.startedAt,
              });
              yield* hub.publish({ type: 'bench-run', payload: saved });
            }
            if (Option.isSome(s.sweep)) {
              const sweep = yield* sweeps.setStatus(s.sweep.value.id, 'interrupted');
              yield* hub.publish({ type: 'sweep', payload: sweep });
            }
            if (Option.isSome(s.current)) yield* hub.publish({ type: 'bench-progress', payload: null });
            if (Option.isSome(s.sweepLive)) yield* hub.publish({ type: 'sweep-progress', payload: null });
          }),
        );

        return BenchRunner.of({
          busy,
          live: Effect.map(SynchronizedRef.get(state), (s) => Option.getOrNull(Option.map(s.current, (c) => c.live))),
          sweepLive: Effect.map(SynchronizedRef.get(state), (s) => Option.getOrNull(s.sweepLive)),
          files: Effect.map(SynchronizedRef.get(state), (s) =>
            Arr.dedupe([
              ...Option.match(s.current, { onNone: () => [], onSome: (c) => filesOf(c.files) }),
              ...Option.match(s.sweep, { onNone: () => [], onSome: (sw) => filesOf(sw.files) }),
            ]),
          ),
          start,
          startSweep,
          resume,
          validate,
          cancel,
          cancelSweep,
        });
      }),
    );

  /** The app's runner: SIGKILL 5 s after SIGTERM, 1 s between sweep items, 60 s for a stop, 250 ms of live. */
  static readonly layer = BenchRunner.layerWith({
    killTimeout: '5 seconds',
    pause: '1 second',
    stoppingTimeout: '60 seconds',
    liveThrottle: '250 millis',
  });
}
