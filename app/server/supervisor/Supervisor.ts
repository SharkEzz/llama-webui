import {
  OperationInProgress,
  PortInUse,
  ServerAlreadyRunning,
  type ServerState,
  type ServerView,
  serverView,
  stateLoadProgress,
} from '@llama-webui/shared';
import {
  Cause,
  Clock,
  Context,
  Duration,
  Effect,
  Equal,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Metric,
  Option,
  type Path,
  Predicate,
  PubSub,
  Schema,
  Scope,
  Semaphore,
  Stream,
  SynchronizedRef,
} from 'effect';
import { ChildProcess, type ChildProcessSpawner } from 'effect/process';
import { probeUrl } from 'llamacpp-js/client';
import type { ModelMemory, ModelsSseEvent } from 'llamacpp-js/models';
import type { LlamaHttp } from '../llama/LlamaHttp.ts';
import { sanitizeLoadProgress, streamModelsSse } from '../llama/modelsSse.ts';
import { health, isLlamaServer, props } from '../llama/probes.ts';
import { findLlamaServerPid, isAlive } from '../llama/procScan.ts';
import { isIdleNoise, linesOf } from '../logs/lines.ts';
import { LogRing } from '../logs/LogRing.ts';
import { causeMessage, type Ending, endingOf } from '../process/ending.ts';
import { FORCE_KILL_AFTER, type Followed, followProgram } from '../process/followed.ts';
import { LlamaMetrics } from '../runtime/Metrics.ts';
import { WsHub } from '../ws/WsHub.ts';
import { type BuiltCommand, launchLines } from './command.ts';

/** The process llama-webui runs, while it runs. */
interface Running {
  /** The process, its readers and its SSE/health watcher; `ended` once its exit was handled and its scope closed. */
  readonly program: Followed;
  readonly cmd: BuiltCommand;
}

/** What the supervisor holds: the state, the last command launched, the running process, SSE memory and external watch scope. */
interface Held {
  readonly state: ServerState;
  readonly last: Option.Option<BuiltCommand>;
  readonly proc: Option.Option<Running>;
  /** Active memory breakdown from `/models/sse`; null when not loaded, sleeping, or unsupported. */
  readonly memory: ModelMemory | null;
  /** Last memory breakdown received from `/models/sse` for this server, restored on wakeup from sleep. */
  readonly lastLoadedMemory: ModelMemory | null;
  /** Scope of the SSE watcher attached to the current external server; closed when leaving `external`. */
  readonly externalScope: Option.Option<Scope.Closeable>;
}

const exitedLine = ({ code, signal }: Ending) =>
  `[llama-webui] llama-server exited (code ${code ?? '-'}${signal === null ? '' : `, ${signal}`})`;

/** The fields of a state of a launched server. */
const launchedOf = (cmd: BuiltCommand, pid: number) => ({
  profile: cmd.profileName,
  profileId: cmd.profileId,
  pid,
  host: cmd.host,
  port: cmd.port,
});

const isSameExternal = (state: ServerState, port: number, pid: number | null): boolean =>
  state.kind === 'external' && state.port === port && state.pid === pid;

const isServerProps = Schema.is(Schema.Struct({ role: Schema.optionalKey(Schema.String) }));

/** The llama-server llama-webui runs: its state, one lifecycle operation at a time, the process in a scope of its own. */
export class Supervisor extends Context.Service<
  Supervisor,
  {
    readonly state: Effect.Effect<ServerState>;
    /** The last command launched (kept after a stop), none before any launch. */
    readonly lastCommand: Effect.Effect<Option.Option<BuiltCommand>>;
    readonly view: Effect.Effect<ServerView>;
    /** Every new state from the subscription on, in the order of the changes; subscribed when the effect runs. */
    readonly changes: Effect.Effect<Stream.Stream<ServerState>, never, Scope.Scope>;
    /** Memory breakdown reported by `/models/sse` for the active server (managed or external); null when unavailable or sleeping. */
    readonly memory: Effect.Effect<ModelMemory | null>;
    /** Every change of `memory` from the subscription on, in order. */
    readonly memoryChanges: Effect.Effect<Stream.Stream<ModelMemory | null>, never, Scope.Scope>;
    readonly start: (cmd: BuiltCommand) => Effect.Effect<void, OperationInProgress | ServerAlreadyRunning | PortInUse>;
    /** Stops the managed server, then launches `cmd`, as one operation. */
    readonly switchTo: (cmd: BuiltCommand) => Effect.Effect<void, OperationInProgress | PortInUse>;
    /** Waits for the operation in progress, then stops the managed server; never touches an external one. */
    readonly stop: Effect.Effect<void>;
    /** A llama-server on `port` that llama-webui did not start: the state becomes `external`. */
    readonly detectExternal: (port: number) => Effect.Effect<boolean>;
    /** Leaves the `external` state once that server is gone. */
    readonly recheckExternal: Effect.Effect<void>;
  }
>()('@llama-webui/app/server/supervisor/Supervisor') {
  /**
   * The supervisor: a stop sends SIGTERM, then SIGKILL after `killTimeout`; a starting server follows `/models/sse`
   * (single-model mode, llama.cpp PR #32398) while polling `/health` every `healthPoll` during cold startup;
   * the pid of a server started by hand is read from `procRoot`. The end of the layer stops the managed server; an
   * exit of llama-webui without its finalizers kills it (SIGKILL).
   */
  static readonly layerWith = (options: {
    readonly killTimeout: Duration.Input;
    readonly healthPoll: Duration.Input;
    readonly procRoot?: string;
  }): Layer.Layer<
    Supervisor,
    never,
    LogRing | WsHub | LlamaHttp | ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
  > =>
    Layer.effect(
      Supervisor,
      Effect.gen(function* () {
        const ring = yield* LogRing;
        const hub = yield* WsHub;
        const fs = yield* FileSystem.FileSystem;
        const context = yield* Effect.context<
          LlamaHttp | FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
        >();
        const killTimeout = Duration.fromInputUnsafe(options.killTimeout);
        const procRoot = options.procRoot ?? '/proc';

        const held = yield* SynchronizedRef.make<Held>({
          state: { kind: 'idle' },
          last: Option.none(),
          proc: Option.none(),
          memory: null,
          lastLoadedMemory: null,
          externalScope: Option.none(),
        });
        const lock = yield* Semaphore.make(1);
        const states = yield* PubSub.unbounded<ServerState>();
        const memories = yield* PubSub.unbounded<ModelMemory | null>();

        // Last resort: an exit of llama-webui without its finalizers (an uncaught error) still kills llama-server.
        // A plain variable, read by a synchronous handler.
        let livePid: number | null = null;
        const killLive = () => {
          if (livePid === null) return;
          try {
            process.kill(livePid, 'SIGKILL');
          } catch {
            // Already gone.
          }
        };
        yield* Effect.acquireRelease(
          Effect.sync(() => process.on('exit', killLive)),
          () => Effect.sync(() => process.off('exit', killLive)),
        );

        // The operations and the exit watchers run in fibers of their own, in a scope the end of the layer closes
        // after it stopped llama-server: a caller that goes away does not end an operation.
        const layerScope = yield* Effect.scope;
        const ops = yield* Scope.fork(layerScope);

        const closeScope = (scope: Option.Option<Scope.Closeable>): Effect.Effect<void> =>
          Option.match(scope, { onNone: () => Effect.void, onSome: (s) => Scope.close(s, Exit.void) });

        /**
         * The one way the state changes: `f` sees what is held and answers what to hold instead, or none (the state is
         * no longer the one its caller saw). A new state is published as `server-state` and to `changes`, and a new
         * memory breakdown to `memoryChanges`, under the same lock: clients and subscribers get updates in order.
         * Answers whether `f` changed anything.
         */
        const change = (f: (now: Held) => Option.Option<Held>): Effect.Effect<boolean> =>
          SynchronizedRef.modifyEffect(held, (now) =>
            Option.match(f(now), {
              onNone: () => Effect.succeed([false, now] as const),
              onSome: (next) => {
                const stateChanged = !Equal.equals(next.state, now.state);
                const memoryChanged = !Equal.equals(next.memory, now.memory);
                const replacedExternal =
                  Option.isSome(now.externalScope) &&
                  (Option.isNone(next.externalScope) || next.externalScope.value !== now.externalScope.value);
                return Effect.gen(function* () {
                  if (replacedExternal) yield* closeScope(now.externalScope);
                  if (stateChanged) {
                    yield* hub.publish({ type: 'server-state', payload: viewOf(next) });
                    yield* PubSub.publish(states, next.state);
                    yield* measured(now.state, next.state);
                  }
                  if (memoryChanged) {
                    yield* PubSub.publish(memories, next.memory);
                  }
                  return [true, next] as const;
                });
              },
            }),
          );

        /** The metrics of a change of state: the state entered, whether it is ready, and how long a launch took. */
        const measured = Effect.fnUntraced(function* (before: ServerState, after: ServerState) {
          if (before.kind !== after.kind) {
            yield* Metric.update(LlamaMetrics.transitions, after.kind);
            yield* Metric.update(LlamaMetrics.ready, after.kind === 'ready' ? 1 : 0);
          }
          // A wake-up from sleep reloads the model of a running server: not a launch.
          if (before.kind === 'starting' && before.waking !== true && after.kind === 'ready') {
            yield* Metric.update(LlamaMetrics.startup, Duration.millis(after.since - before.since));
          }
        });

        const viewOf = (h: Held): ServerView => serverView({ state: h.state, last: Option.getOrNull(h.last) });

        const isThis = (running: Running) => (h: Held) => Option.exists(h.proc, (p) => p.program === running.program);

        /**
         * Handles the exit of `running`, once its readers were joined (at most 1 s, `followProgram`): logs the exit,
         * sets `idle` after a stop or `crashed` otherwise. Its scope is closed next, then `ended` completes.
         */
        const exited = (running: Running, ending: Ending): Effect.Effect<void> =>
          Effect.gen(function* () {
            yield* ring.push(exitedLine(ending));
            const at = yield* Clock.currentTimeMillis;
            yield* change((now) =>
              isThis(running)(now)
                ? Option.some({
                    ...now,
                    proc: Option.none(),
                    memory: null,
                    lastLoadedMemory: null,
                    state:
                      now.state.kind === 'stopping'
                        ? { kind: 'idle' }
                        : {
                            kind: 'crashed',
                            profile: running.cmd.profileName,
                            profileId: running.cmd.profileId,
                            exitCode: ending.code,
                            signal: ending.signal,
                            at,
                          },
                  })
                : Option.none(),
            );
            if (livePid === running.program.handle.pid) livePid = null;
          });

        /** A launch that ended before llama-server ran: the ring says why, the state is `crashed` with the message. */
        const launchFailed = Effect.fnUntraced(function* (cmd: BuiltCommand, message: string) {
          yield* ring.push(`[llama-webui] launch failed: ${message}`);
          const at = yield* Clock.currentTimeMillis;
          yield* change((now) =>
            Option.some({
              ...now,
              memory: null,
              lastLoadedMemory: null,
              state: {
                kind: 'crashed',
                profile: cmd.profileName,
                profileId: cmd.profileId,
                exitCode: null,
                signal: null,
                at,
                message,
              },
            }),
          );
        });

        /** What is written to a stream of the process, line by line, into the ring (the idle noise left out). */
        const read = (bytes: Stream.Stream<Uint8Array, unknown>) =>
          linesOf(bytes).pipe(
            Stream.filter((line) => !isIdleNoise(line)),
            Stream.runForEach(ring.push),
            Effect.ignore,
          );

        /** Polls independently of SSE during cold startup. A wakeup relies on SSE because /health also answers in sleep. */
        const pollStartup = Effect.fnUntraced(function* (running: Running, startedAt: number) {
          const target = { host: running.cmd.host, port: running.cmd.port };
          const isColdStart = (now: Held) =>
            isThis(running)(now) && now.state.kind === 'starting' && now.state.since === startedAt;
          for (;;) {
            yield* Effect.sleep(options.healthPoll);
            const current = yield* SynchronizedRef.get(held);
            if (!isColdStart(current)) return;
            const status = yield* health(target);
            if (!Option.contains(status, 200)) continue;
            const since = yield* Clock.currentTimeMillis;
            yield* change((now) =>
              isColdStart(now)
                ? Option.some({
                    ...now,
                    state: { kind: 'ready', ...launchedOf(running.cmd, running.program.handle.pid), since },
                  })
                : Option.none(),
            );
            return;
          }
        }, Effect.provideContext(context));

        /** Applies one `/models/sse` event to a managed server's state and memory. */
        const applyManagedEvent = Effect.fnUntraced(function* (running: Running, event: ModelsSseEvent) {
          if (event.event !== 'status_change') return;
          const nowMs = yield* Clock.currentTimeMillis;
          yield* change((now) => {
            if (!isThis(running)(now) || now.state.kind === 'stopping') return Option.none();
            if (event.status === 'loading') {
              const progress =
                event.progress === undefined
                  ? undefined
                  : sanitizeLoadProgress({ progress: event.progress, previous: stateLoadProgress(now.state) });
              if (now.state.kind === 'starting') {
                if (progress === undefined || Equal.equals(now.state.progress, progress)) return Option.none();
                return Option.some({ ...now, state: { ...now.state, progress } });
              }
              if (now.state.kind === 'sleeping') {
                // llama-server queues the requests it receives while it reloads: the state still serves them.
                return Option.some({
                  ...now,
                  memory: null,
                  state: {
                    kind: 'starting',
                    ...launchedOf(running.cmd, running.program.handle.pid),
                    since: nowMs,
                    ...(progress === undefined ? {} : { progress }),
                    waking: true,
                  },
                });
              }
              return Option.none();
            }
            if (event.status === 'loaded') {
              const lastLoadedMemory = event.memory ?? now.lastLoadedMemory;
              const memory = event.memory ?? now.lastLoadedMemory;
              if (now.state.kind === 'starting' || now.state.kind === 'sleeping') {
                return Option.some({
                  ...now,
                  memory,
                  lastLoadedMemory,
                  state: { kind: 'ready', ...launchedOf(running.cmd, running.program.handle.pid), since: nowMs },
                });
              }
              if (now.state.kind === 'ready' && !Equal.equals(now.memory, memory)) {
                return Option.some({ ...now, memory, lastLoadedMemory });
              }
              return Option.none();
            }
            if (event.status === 'sleeping') {
              if (now.state.kind === 'ready' || now.state.kind === 'starting') {
                return Option.some({
                  ...now,
                  memory: null,
                  state: { kind: 'sleeping', ...launchedOf(running.cmd, running.program.handle.pid), since: nowMs },
                });
              }
              return Option.none();
            }
            return Option.none();
          });
        });

        /**
         * Follows `/models/sse` for the lifetime of `running` if the binary supports it. Runs in `running.program.scope`.
         * A non-2xx answer means an older build only until the stream has answered once for this process: after that,
         * it is transient and the watcher reconnects, since only the stream sees a wake-up end (`/health` answers 200
         * during a sleep).
         */
        const watchManaged = (running: Running): Effect.Effect<void> =>
          Effect.gen(function* () {
            const target = { host: running.cmd.host, port: running.cmd.port };
            let supported = false;
            /** One connection to the stream: whether to connect again. */
            const round = Effect.gen(function* () {
              const outcome = yield* streamModelsSse(target).pipe(
                Stream.runForEach((event) =>
                  Effect.andThen(
                    Effect.sync(() => {
                      supported = true;
                    }),
                    applyManagedEvent(running, event),
                  ),
                ),
                Effect.result,
              );
              if (outcome._tag === 'Success' || outcome.failure._tag === 'ModelsSseCut') supported = true;
              else if (outcome.failure._tag === 'ModelsSseUnsupported' && !supported) return false;
              return true;
            }).pipe(
              Effect.catchCauseIf(Predicate.not(Cause.hasInterruptsOnly), (cause) =>
                Effect.as(Effect.logError('following /models/sse of llama-server', cause), true),
              ),
            );
            for (;;) {
              const current = yield* SynchronizedRef.get(held);
              if (!isThis(running)(current) || current.state.kind === 'stopping') return;
              const again = yield* round;
              if (!again) return;
              yield* Effect.sleep(options.healthPoll);
            }
          }).pipe(Effect.provideContext(context));

        /** Applies one `/models/sse` event to an external server's state and memory. */
        const applyExternalEvent = Effect.fnUntraced(function* (
          port: number,
          pid: number | null,
          event: ModelsSseEvent,
        ) {
          if (event.event !== 'status_change') return;
          if (event.status === 'unloaded') {
            yield* recheckExternal;
            return;
          }
          yield* change((now) => {
            if (!isSameExternal(now.state, port, pid)) return Option.none();
            if (event.status === 'loading') {
              const previous = stateLoadProgress(now.state);
              const progress =
                event.progress === undefined ? previous : sanitizeLoadProgress({ progress: event.progress, previous });
              const nextState: ServerState = {
                kind: 'external',
                pid,
                port,
                status: 'loading',
                ...(progress === null ? {} : { progress }),
              };
              if (Equal.equals(now.state, nextState) && now.memory === null) return Option.none();
              return Option.some({ ...now, memory: null, state: nextState });
            }
            if (event.status === 'loaded') {
              const lastLoadedMemory = event.memory ?? now.lastLoadedMemory;
              const memory = event.memory ?? now.lastLoadedMemory;
              const nextState: ServerState = { kind: 'external', pid, port, status: 'ready' };
              if (Equal.equals(now.state, nextState) && Equal.equals(now.memory, memory)) return Option.none();
              return Option.some({ ...now, memory, lastLoadedMemory, state: nextState });
            }
            if (event.status === 'sleeping') {
              const nextState: ServerState = { kind: 'external', pid, port, status: 'sleeping' };
              if (Equal.equals(now.state, nextState) && now.memory === null) return Option.none();
              return Option.some({ ...now, memory: null, state: nextState });
            }
            return Option.none();
          });
        });

        /**
         * Follows `/models/sse` for an external single-model server. A router's events describe individual models.
         */
        const watchExternal = (port: number, pid: number | null): Effect.Effect<void> =>
          Effect.gen(function* () {
            /** One look at `/props`, then one connection to the stream: whether to try again. */
            const round = Effect.gen(function* () {
              const details = yield* props(probeUrl(null, port)).pipe(Effect.option);
              if (Option.isNone(details)) {
                // A 503 during the first load, a slow or failed answer: tried again while this server is the one
                // watched. A server gone leaves `external` (the loop ends at its next round).
                const status = yield* health({ port });
                if (Option.isNone(status)) yield* recheckExternal;
                return true;
              }
              if (!isServerProps(details.value) || details.value.role === 'router') return false;
              const outcome = yield* streamModelsSse({ port }).pipe(
                Stream.runForEach((event) => applyExternalEvent(port, pid, event)),
                Effect.result,
              );
              if (outcome._tag === 'Success') yield* recheckExternal;
              else if (outcome.failure._tag === 'ModelsSseUnsupported') return false;
              return true;
            }).pipe(
              Effect.catchCauseIf(Predicate.not(Cause.hasInterruptsOnly), (cause) =>
                Effect.as(Effect.logError('following /models/sse of an external llama-server', cause), true),
              ),
            );
            for (;;) {
              const current = yield* SynchronizedRef.get(held);
              if (!isSameExternal(current.state, port, pid)) return;
              const again = yield* round;
              if (!again) return;
              yield* Effect.sleep(options.healthPoll);
            }
          }).pipe(Effect.provideContext(context));

        /** Transitions `idle` or `crashed` into `external` and starts its scoped `/models/sse` watcher. */
        const enterExternal = Effect.fnUntraced(function* (port: number, pid: number | null) {
          const extScope = yield* Scope.fork(ops);
          const entered = yield* change((now) =>
            Option.isNone(now.proc) && (now.state.kind === 'idle' || now.state.kind === 'crashed')
              ? Option.some({
                  ...now,
                  memory: null,
                  lastLoadedMemory: null,
                  externalScope: Option.some(extScope),
                  state: { kind: 'external', pid, port },
                })
              : Option.none(),
          );
          if (!entered) {
            yield* Scope.close(extScope, Exit.void);
            return false;
          }
          yield* watchExternal(port, pid).pipe(Effect.forkIn(extScope));
          return true;
        });

        /** The port of `cmd` answers already: whose it is. */
        const portTaken = Effect.fnUntraced(function* (cmd: BuiltCommand) {
          const target = { host: cmd.host, port: cmd.port };
          if (!(yield* isLlamaServer(target))) {
            return PortInUse.make({
              message: `port ${cmd.port} is in use by another service`,
              port: cmd.port,
              by: 'other',
              pid: null,
            });
          }
          const pid = yield* findLlamaServerPid({ port: cmd.port, root: procRoot }).pipe(Effect.map(Option.getOrNull));
          yield* enterExternal(cmd.port, pid);
          return externalError(cmd.port, pid);
        }, Effect.provideContext(context));

        const externalError = (port: number, pid: number | null) =>
          PortInUse.make({
            message: `port in use by an external server (PID ${pid ?? 'unknown'})`,
            port,
            by: 'llama-server',
            pid,
          });

        const doStart = Effect.fnUntraced(function* (cmd: BuiltCommand) {
          const before = yield* SynchronizedRef.get(held);
          if (before.state.kind === 'external') {
            const external = before.state;
            // The external server may have been stopped since it was seen.
            const answers = yield* health({ port: external.port });
            if (Option.isSome(answers)) {
              return yield* externalError(external.port, external.pid);
            }
            yield* change((now) =>
              isSameExternal(now.state, external.port, external.pid)
                ? Option.some({
                    ...now,
                    memory: null,
                    lastLoadedMemory: null,
                    externalScope: Option.none(),
                    state: { kind: 'idle' },
                  })
                : Option.none(),
            );
          }
          if (Option.isSome(before.proc)) {
            return yield* ServerAlreadyRunning.make({ message: 'a server is already running' });
          }
          const taken = yield* health({ host: cmd.host, port: cmd.port });
          if (Option.isSome(taken)) {
            const error = yield* portTaken(cmd);
            return yield* error;
          }

          yield* SynchronizedRef.update(held, (now) => ({ ...now, last: Option.some(cmd) }));
          if (!(yield* fs.exists(cmd.cwd).pipe(Effect.orElseSucceed(() => false)))) {
            return yield* launchFailed(cmd, `directory not found: ${cmd.cwd}`);
          }
          const [binary = '', ...args] = cmd.argv;
          const spawned = yield* followProgram({
            command: ChildProcess.make(binary, args, {
              cwd: cmd.cwd,
              env: { ...cmd.env },
              extendEnv: true,
              stdin: 'ignore',
              forceKillAfter: FORCE_KILL_AFTER,
            }),
            parent: ops,
            name: 'llama-server',
            // The state names the process before its output is read and its exit watched: an exit seen at once
            // still finds it.
            onSpawn: Effect.fnUntraced(function* (program) {
              const { handle } = program;
              livePid = handle.pid;
              const running: Running = { program, cmd };
              yield* Effect.forEach(launchLines(cmd), ring.push, { discard: true });
              const since = yield* Clock.currentTimeMillis;
              yield* change((now) =>
                Option.some({
                  ...now,
                  proc: Option.some(running),
                  memory: null,
                  lastLoadedMemory: null,
                  externalScope: Option.none(),
                  state: { kind: 'starting', ...launchedOf(cmd, handle.pid), since },
                }),
              );
              yield* watchManaged(running).pipe(Effect.forkIn(program.scope));
              yield* pollStartup(running, since).pipe(Effect.forkIn(program.scope));
            }),
            read: ({ handle }) =>
              Effect.all([read(handle.stdout), read(handle.stderr)], { concurrency: 2, discard: true }),
            onExit: (ended, program) => exited({ program, cmd }, endingOf(ended)),
          }).pipe(Effect.result);
          if (spawned._tag === 'Failure') return yield* launchFailed(cmd, causeMessage(spawned.failure));
        }, Effect.provideContext(context));

        const doStop = Effect.gen(function* () {
          const now = yield* SynchronizedRef.get(held);
          if (Option.isNone(now.proc)) {
            yield* change((h) =>
              h.state.kind === 'crashed' && Option.isNone(h.proc)
                ? Option.some({ ...h, memory: null, lastLoadedMemory: null, state: { kind: 'idle' } })
                : Option.none(),
            );
            return;
          }
          const running = now.proc.value;
          yield* change((h) =>
            isThis(running)(h) &&
            (h.state.kind === 'starting' || h.state.kind === 'ready' || h.state.kind === 'sleeping')
              ? Option.some({
                  ...h,
                  state: { kind: 'stopping', ...launchedOf(running.cmd, running.program.handle.pid) },
                })
              : Option.none(),
          );
          // The wait is made interruptible for the timeout to end it, in a finalizer too.
          const { handle } = running.program;
          const stopAt = yield* Clock.currentTimeMillis;
          const stopped = yield* handle
            .kill({ killSignal: 'SIGTERM' })
            .pipe(Effect.ignore, Effect.interruptible, Effect.timeoutOption(killTimeout));
          if (Option.isNone(stopped)) {
            yield* Metric.update(LlamaMetrics.sigkill, 1);
            yield* ring.push(`[llama-webui] not stopped after ${Duration.toMillis(killTimeout)} ms, SIGKILL`);
            yield* handle.kill({ killSignal: 'SIGKILL' }).pipe(Effect.ignore);
          }
          // Its exit handled by the fiber that watches it: the state says so, its scope is closed.
          yield* running.program.ended;
          const endAt = yield* Clock.currentTimeMillis;
          yield* Metric.update(LlamaMetrics.stop, Duration.millis(endAt - stopAt));
        });

        /** Runs `operation` in a fiber of `ops` and waits for it: the caller may go away, the operation runs to its end. */
        const detached = <A, E>(operation: Effect.Effect<A, E>) =>
          Effect.uninterruptibleMask((restore) =>
            Effect.flatMap(Effect.forkIn(operation, ops, { startImmediately: true }), (fiber) =>
              restore(Fiber.join(fiber)),
            ),
          );

        /** `operation` if no other one runs, else `OperationInProgress`. */
        const exclusive = <A, E>(operation: Effect.Effect<A, E>) =>
          Effect.uninterruptibleMask((restore) =>
            Effect.gen(function* () {
              if (!(yield* Semaphore.takeIfAvailable(lock, 1))) {
                return yield* OperationInProgress.make({ message: 'operation in progress, try again' });
              }
              const fiber = yield* operation.pipe(Effect.ensuring(Semaphore.release(lock, 1)), Effect.forkIn(ops));
              return yield* restore(Fiber.join(fiber));
            }),
          );

        const start = Effect.fn('Supervisor.start')(function* (cmd: BuiltCommand) {
          return yield* exclusive(doStart(cmd));
        });

        const switchTo = Effect.fn('Supervisor.switchTo')(function* (cmd: BuiltCommand) {
          return yield* exclusive(
            doStop.pipe(
              Effect.andThen(doStart(cmd)),
              // No server runs after the stop: the start cannot find one.
              Effect.catchTag('ServerAlreadyRunning', Effect.die),
            ),
          );
        });

        const stop = doStop.pipe(Semaphore.withPermits(lock, 1), detached, Effect.withSpan('Supervisor.stop'));

        const detectExternal = Effect.fn('Supervisor.detectExternal')(function* (port: number) {
          const before = yield* SynchronizedRef.get(held);
          if (Option.isSome(before.proc)) return false;
          if (!(yield* isLlamaServer({ port }))) return false;
          const pid = yield* findLlamaServerPid({ port, root: procRoot }).pipe(Effect.map(Option.getOrNull));
          return yield* enterExternal(port, pid);
        }, Effect.provideContext(context));

        const recheckExternal = Effect.gen(function* () {
          const { state } = yield* SynchronizedRef.get(held);
          if (state.kind !== 'external') return;
          // Alive but silent: a hung server, still watched.
          if (state.pid !== null && (yield* isAlive(state.pid))) return;
          const answers = yield* health({ port: state.port });
          if (Option.isSome(answers)) return;
          yield* change((now) =>
            isSameExternal(now.state, state.port, state.pid)
              ? Option.some({
                  ...now,
                  memory: null,
                  lastLoadedMemory: null,
                  externalScope: Option.none(),
                  state: { kind: 'idle' },
                })
              : Option.none(),
          );
        }).pipe(Effect.provideContext(context), Effect.withSpan('Supervisor.recheckExternal'));

        // The end of the layer: after the operation in progress, llama-server is stopped as a stop does.
        yield* Effect.addFinalizer(() =>
          Semaphore.withPermits(
            lock,
            1,
          )(
            Effect.gen(function* () {
              const now = yield* SynchronizedRef.get(held);
              if (Option.isNone(now.proc)) return;
              yield* Effect.logInfo('stopping llama-server…');
              yield* doStop;
            }),
          ),
        );

        return Supervisor.of({
          state: Effect.map(SynchronizedRef.get(held), (h) => h.state),
          lastCommand: Effect.map(SynchronizedRef.get(held), (h) => h.last),
          view: Effect.map(SynchronizedRef.get(held), viewOf),
          changes: Effect.map(PubSub.subscribe(states), Stream.fromSubscription),
          memory: Effect.map(SynchronizedRef.get(held), (h) => h.memory),
          memoryChanges: Effect.map(PubSub.subscribe(memories), Stream.fromSubscription),
          start,
          switchTo,
          stop,
          detectExternal,
          recheckExternal,
        });
      }),
    );

  /** SIGKILL 5 s after SIGTERM, `/health` polled every 500 ms during startup, pids read from `/proc`. */
  static readonly layer = Supervisor.layerWith({ killTimeout: '5 seconds', healthPoll: '500 millis' });
}
