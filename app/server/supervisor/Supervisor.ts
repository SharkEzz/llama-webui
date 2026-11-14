import {
  OperationInProgress,
  PortInUse,
  ServerAlreadyRunning,
  type ServerState,
  type ServerView,
  serverView,
} from '@llama-webui/shared';
import {
  Clock,
  Context,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Option,
  type Path,
  Predicate,
  PubSub,
  Ref,
  Scope,
  Semaphore,
  Stream,
  SynchronizedRef,
} from 'effect';
import { ChildProcess, ChildProcessSpawner } from 'effect/process';
import type { LlamaHttp } from '../llama/LlamaHttp.ts';
import { health, isLlamaServer } from '../llama/probes.ts';
import { findLlamaServerPid, isAlive } from '../llama/procScan.ts';
import { LogRing } from '../logs/LogRing.ts';
import { isIdleNoise, linesOf } from '../logs/lines.ts';
import { WsHub } from '../ws/WsHub.ts';
import { type BuiltCommand, launchLines } from './command.ts';

/** How long the exit waits for the readers of the output: a grandchild may hold the pipes. */
const DRAIN_TIMEOUT = '1 second';

/** The backstop of a process scope closed on a live process: SIGKILL that long after its SIGTERM. */
const FORCE_KILL_AFTER = '1 second';

/** The process llama-webui runs, while it runs. */
interface Running {
  readonly handle: ChildProcessSpawner.ChildProcessHandle;
  readonly cmd: BuiltCommand;
  /** Holds the process, its readers and its health poll. */
  readonly scope: Scope.Closeable;
  /** Completed once both readers ended. */
  readonly drained: Deferred.Deferred<void>;
  /** Whether someone took on the exit: it is handled once. */
  readonly claimed: Ref.Ref<boolean>;
  /** Completed once the exit was handled: the state says so, the scope is closed. */
  readonly settled: Deferred.Deferred<void>;
}

/** What the supervisor holds: the state, the last command launched, and the process it runs. */
interface Held {
  readonly state: ServerState;
  readonly last: Option.Option<BuiltCommand>;
  readonly proc: Option.Option<Running>;
}

/** How a process ended: its code, or the signal that ended it. */
interface Ending {
  readonly code: number | null;
  readonly signal: string | null;
}

const SIGNAL = /signal: '([A-Z0-9]+)'/;

/**
 * The code a process exited with, or the signal that ended it: `exitCode` fails when a signal did, with the signal's
 * name in its cause's message.
 */
const endingOf = (handle: ChildProcessSpawner.ChildProcessHandle): Effect.Effect<Ending> =>
  handle.exitCode.pipe(
    Effect.map((code): Ending => ({ code, signal: null })),
    Effect.catch((error) =>
      Effect.succeed<Ending>({
        code: null,
        signal: Option.fromNullishOr(SIGNAL.exec(causeMessage(error))?.[1]).pipe(Option.getOrNull),
      }),
    ),
  );

/** The message of a platform error's cause (Node's own: `spawn setpriv ENOENT`), else its own. */
const causeMessage = (error: { readonly message: string; readonly cause?: unknown }): string =>
  Predicate.isError(error.cause) ? error.cause.message : error.message;

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
   * The supervisor: a stop sends SIGTERM, then SIGKILL after `killTimeout`; a starting server's `/health` is polled
   * every `healthPoll`; the pid of a server started by hand is read from `procRoot`. The end of the layer stops the
   * managed server; an exit of llama-webui without its finalizers kills it (SIGKILL).
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
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const context = yield* Effect.context<LlamaHttp | FileSystem.FileSystem | Path.Path>();
        const killTimeout = Duration.fromInputUnsafe(options.killTimeout);
        const procRoot = options.procRoot ?? '/proc';

        const held = yield* SynchronizedRef.make<Held>({
          state: { kind: 'idle' },
          last: Option.none(),
          proc: Option.none(),
        });
        const lock = yield* Semaphore.make(1);
        const states = yield* PubSub.unbounded<ServerState>();

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

        /**
         * The one way the state changes: `f` sees what is held and answers what to hold instead, or none (the state is
         * no longer the one its caller saw). A new state is published as `server-state` and to `changes`, under the
         * same lock: the clients and the subscribers get the states in the order they happened. Answers whether `f`
         * changed anything.
         */
        const change = (f: (now: Held) => Option.Option<Held>): Effect.Effect<boolean> =>
          SynchronizedRef.modifyEffect(held, (now) =>
            Option.match(f(now), {
              onNone: () => Effect.succeed([false, now] as const),
              onSome: (next) =>
                (next.state === now.state
                  ? Effect.void
                  : hub
                      .publish({ type: 'server-state', payload: viewOf(next) })
                      .pipe(Effect.andThen(PubSub.publish(states, next.state)))
                ).pipe(Effect.as([true, next] as const)),
            }),
          );

        const viewOf = (h: Held): ServerView => serverView({ state: h.state, last: Option.getOrNull(h.last) });

        const isThis = (running: Running) => (h: Held) => Option.exists(h.proc, (p) => p === running);

        /**
         * Handles the exit of `running` once, whoever sees it first: waits for the readers (at most 1 s), logs the
         * exit, sets `idle` after a stop or `crashed` otherwise, closes the process's scope. The others wait for it.
         */
        const settle = (running: Running): Effect.Effect<void> =>
          Effect.gen(function* () {
            if (yield* Ref.getAndSet(running.claimed, true)) return yield* Deferred.await(running.settled);
            const ending = yield* endingOf(running.handle);
            // Made interruptible for the timeout to end it: the rest runs whatever happens.
            yield* Deferred.await(running.drained).pipe(Effect.interruptible, Effect.timeoutOption(DRAIN_TIMEOUT));
            yield* ring.push(exitedLine(ending));
            const at = yield* Clock.currentTimeMillis;
            yield* change((now) =>
              isThis(running)(now)
                ? Option.some({
                    ...now,
                    proc: Option.none(),
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
            if (livePid === running.handle.pid) livePid = null;
            yield* Scope.close(running.scope, Exit.void);
            yield* Deferred.succeed(running.settled, undefined);
          }).pipe(Effect.uninterruptible);

        /** A launch that ended before llama-server ran: the ring says why, the state is `crashed` with the message. */
        const launchFailed = (cmd: BuiltCommand, message: string) =>
          Effect.gen(function* () {
            yield* ring.push(`[llama-webui] launch failed: ${message}`);
            const at = yield* Clock.currentTimeMillis;
            yield* change((now) =>
              Option.some({
                ...now,
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

        /** `/health` of the server every `healthPoll` until it answers 200 (`ready`) or is no longer starting. */
        const pollHealth = (running: Running) =>
          Effect.gen(function* () {
            const status = yield* health({ host: running.cmd.host, port: running.cmd.port });
            if (Option.getOrNull(status) !== 200) return false;
            const since = yield* Clock.currentTimeMillis;
            yield* change((now) =>
              isThis(running)(now) && now.state.kind === 'starting'
                ? Option.some({
                    ...now,
                    state: { kind: 'ready', ...launchedOf(running.cmd, running.handle.pid), since },
                  })
                : Option.none(),
            );
            return true;
          }).pipe(
            Effect.delay(options.healthPoll),
            Effect.repeat({
              until: (ready) => ready,
              while: () =>
                Effect.map(SynchronizedRef.get(held), (now) => isThis(running)(now) && now.state.kind === 'starting'),
            }),
            Effect.provideContext(context),
          );

        /** The port of `cmd` answers already: whose it is. */
        const portTaken = (cmd: BuiltCommand) =>
          Effect.gen(function* () {
            const target = { host: cmd.host, port: cmd.port };
            if (!(yield* isLlamaServer(target))) {
              return PortInUse.make({
                message: `port ${cmd.port} is in use by another service`,
                port: cmd.port,
                by: 'other',
                pid: null,
              });
            }
            const pid = yield* findLlamaServerPid({ port: cmd.port, root: procRoot }).pipe(
              Effect.map(Option.getOrNull),
            );
            yield* change((now) =>
              Option.isNone(now.proc) && (now.state.kind === 'idle' || now.state.kind === 'crashed')
                ? Option.some({ ...now, state: { kind: 'external', pid, port: cmd.port } })
                : Option.none(),
            );
            return externalError(cmd.port, pid);
          }).pipe(Effect.provideContext(context));

        const externalError = (port: number, pid: number | null) =>
          PortInUse.make({
            message: `port in use by an external server (PID ${pid ?? 'unknown'})`,
            port,
            by: 'llama-server',
            pid,
          });

        const doStart = (cmd: BuiltCommand) =>
          Effect.gen(function* () {
            const before = yield* SynchronizedRef.get(held);
            if (before.state.kind === 'external') {
              const external = before.state;
              // The external server may have been stopped since it was seen.
              const answers = yield* health({ port: external.port });
              if (Option.isSome(answers)) {
                return yield* externalError(external.port, external.pid);
              }
              yield* change((now) =>
                now.state === external ? Option.some({ ...now, state: { kind: 'idle' } }) : Option.none(),
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
            const scope = yield* Scope.fork(ops);
            const [binary = '', ...args] = cmd.argv;
            const spawned = yield* spawner
              .spawn(
                ChildProcess.make(binary, args, {
                  cwd: cmd.cwd,
                  env: { ...cmd.env },
                  extendEnv: true,
                  stdin: 'ignore',
                  forceKillAfter: FORCE_KILL_AFTER,
                }),
              )
              .pipe(Scope.provide(scope), Effect.result);
            if (spawned._tag === 'Failure') {
              yield* Scope.close(scope, Exit.void);
              return yield* launchFailed(cmd, causeMessage(spawned.failure));
            }
            const handle = spawned.success;
            livePid = handle.pid;
            const running: Running = {
              handle,
              cmd,
              scope,
              drained: yield* Deferred.make<void>(),
              claimed: yield* Ref.make(false),
              settled: yield* Deferred.make<void>(),
            };
            yield* Effect.forEach(launchLines(cmd), ring.push, { discard: true });
            const since = yield* Clock.currentTimeMillis;
            yield* change((now) =>
              Option.some({
                ...now,
                proc: Option.some(running),
                state: { kind: 'starting', ...launchedOf(cmd, handle.pid), since },
              }),
            );
            // Started once the state names the process: an exit seen at once still finds it to settle.
            yield* Effect.all([read(handle.stdout), read(handle.stderr)], { concurrency: 2, discard: true }).pipe(
              Effect.ensuring(Deferred.succeed(running.drained, undefined)),
              Effect.forkIn(scope),
            );
            yield* pollHealth(running).pipe(Effect.forkIn(scope));
            yield* handle.exitCode.pipe(Effect.ignore, Effect.andThen(settle(running)), Effect.forkIn(ops));
          }).pipe(Effect.provideContext(context));

        const doStop = Effect.gen(function* () {
          const now = yield* SynchronizedRef.get(held);
          if (Option.isNone(now.proc)) {
            yield* change((h) =>
              h.state.kind === 'crashed' && Option.isNone(h.proc)
                ? Option.some({ ...h, state: { kind: 'idle' } })
                : Option.none(),
            );
            return;
          }
          const running = now.proc.value;
          yield* change((h) =>
            isThis(running)(h) && (h.state.kind === 'starting' || h.state.kind === 'ready')
              ? Option.some({ ...h, state: { kind: 'stopping', ...launchedOf(running.cmd, running.handle.pid) } })
              : Option.none(),
          );
          // The wait is made interruptible for the timeout to end it, in a finalizer too.
          const stopped = yield* running.handle
            .kill({ killSignal: 'SIGTERM' })
            .pipe(Effect.ignore, Effect.interruptible, Effect.timeoutOption(killTimeout));
          if (Option.isNone(stopped)) {
            yield* ring.push(`[llama-webui] not stopped after ${Duration.toMillis(killTimeout)} ms, SIGKILL`);
            yield* running.handle.kill({ killSignal: 'SIGKILL' }).pipe(Effect.ignore);
          }
          yield* settle(running);
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

        const stop = detached(Semaphore.withPermits(lock, 1)(doStop)).pipe(Effect.withSpan('Supervisor.stop'));

        const detectExternal = Effect.fn('Supervisor.detectExternal')(function* (port: number) {
          const before = yield* SynchronizedRef.get(held);
          if (Option.isSome(before.proc)) return false;
          if (!(yield* isLlamaServer({ port }))) return false;
          const pid = yield* findLlamaServerPid({ port, root: procRoot }).pipe(Effect.map(Option.getOrNull));
          return yield* change((now) =>
            Option.isNone(now.proc) && (now.state.kind === 'idle' || now.state.kind === 'crashed')
              ? Option.some({ ...now, state: { kind: 'external', pid, port } })
              : Option.none(),
          );
        }, Effect.provideContext(context));

        const recheckExternal = Effect.gen(function* () {
          const { state } = yield* SynchronizedRef.get(held);
          if (state.kind !== 'external') return;
          // Alive but silent: a hung server, still watched.
          if (state.pid !== null && (yield* isAlive(state.pid))) return;
          const answers = yield* health({ port: state.port });
          if (Option.isSome(answers)) return;
          yield* change((now) =>
            now.state === state ? Option.some({ ...now, state: { kind: 'idle' } }) : Option.none(),
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
          start,
          switchTo,
          stop,
          detectExternal,
          recheckExternal,
        });
      }),
    );

  /** SIGKILL 5 s after SIGTERM, `/health` polled every 500 ms, pids read from `/proc`. */
  static readonly layer = Supervisor.layerWith({ killTimeout: '5 seconds', healthPoll: '500 millis' });
}
