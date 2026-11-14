import type { GpuReading } from '@llama-webui/shared';
import {
  Array as Arr,
  type Cause,
  Clock,
  Deferred,
  type Duration,
  Effect,
  Exit,
  Option,
  Queue,
  Ref,
  Scope,
  String as Str,
  Stream,
} from 'effect';
import { Ndjson } from 'effect/encoding';
import { dual } from 'effect/Function';
import { ChildProcess, ChildProcessSpawner } from 'effect/process';
import type { GpuNeeds, NvidiaReader } from '../gpu.ts';
import { FromSampler, type NvmlProc, type NvmlSnapshot, type NvmlSystem, ToSampler } from './protocol.ts';

/*
 * The NVIDIA reader on NVML: the sampler (`worker.ts`) in a child process, spoken to in NDJSON over its stdin and
 * stdout. When NVML is unusable here, `startNvml` answers none and the collectors fall back to nvidia-smi.
 */

/** What the reader holds of the sampler's messages. */
export interface NvmlState {
  readonly gpus: ReadonlyArray<GpuReading>;
  readonly procs: ReadonlyArray<NvmlProc>;
  /** The driver's versions from the last sample; null before the first one. */
  readonly system: NvmlSystem | null;
  readonly lastSampleAt: number;
  /** The interval the sampler was last asked for. */
  readonly intervalMs: number;
  /** The interval freshness is judged on: the old one stays until the sampler has sampled at the new one. */
  readonly freshIntervalMs: number;
  /** The sampler is gone (an error, an exit): its readings are cleared for good. */
  readonly dead: boolean;
}

/** A sample from the sampler, received at `now`. */
export const onSample: {
  (snapshot: NvmlSnapshot, now: number): (state: NvmlState) => NvmlState;
  (state: NvmlState, snapshot: NvmlSnapshot, now: number): NvmlState;
} = dual(
  3,
  (state: NvmlState, snapshot: NvmlSnapshot, now: number): NvmlState =>
    state.dead
      ? state
      : {
          ...state,
          gpus: snapshot.gpus,
          procs: snapshot.procs,
          system: snapshot.system,
          lastSampleAt: now,
          freshIntervalMs: state.intervalMs,
        },
);

/**
 * A new interval. The round the sampler already scheduled still runs at the old one: what it is about to replace is
 * not marked stale before.
 */
export const onConfigure: {
  (intervalMs: number): (state: NvmlState) => NvmlState;
  (state: NvmlState, intervalMs: number): NvmlState;
} = dual(
  2,
  (state: NvmlState, intervalMs: number): NvmlState => ({
    ...state,
    intervalMs,
    freshIntervalMs: Math.max(state.freshIntervalMs, intervalMs),
  }),
);

/** The sampler is gone: no reading any more. */
const onDeath = (state: NvmlState): NvmlState => ({ ...state, gpus: [], procs: [], dead: true });

/**
 * The readings are recent: a sampler stuck in an NVML call (a driver fault) stops sampling, and old numbers must not
 * pass for live ones.
 */
export const isFresh: {
  (now: number): (state: NvmlState) => boolean;
  (state: NvmlState, now: number): boolean;
} = dual(
  2,
  (state: NvmlState, now: number): boolean => !state.dead && now - state.lastSampleAt <= 3 * state.freshIntervalMs,
);

/**
 * The VRAM `pid` holds on each card. A process NVML cannot report counts the card's VRAM in use (an upper bound), so
 * the card still shows as used by it.
 */
export const procVramOf: {
  (pid: number): (state: NvmlState) => ReadonlyMap<string, number>;
  (state: NvmlState, pid: number): ReadonlyMap<string, number>;
} = dual(2, (state: NvmlState, pid: number): ReadonlyMap<string, number> => {
  const vram = new Map<string, number>();
  const unknown = new Set<string>();
  for (const p of state.procs) {
    if (p.pid !== pid) continue;
    if (p.usedBytes === null) unknown.add(p.key);
    else vram.set(p.key, (vram.get(p.key) ?? 0) + p.usedBytes);
  }
  for (const key of unknown) {
    const card = Arr.findFirst(state.gpus, (g) => g.key === key);
    vram.set(key, Option.isSome(card) ? card.value.vramUsedBytes : (vram.get(key) ?? 0));
  }
  return vram;
});

/**
 * The sampler next to the module that starts it: `worker.ts` next to a `.ts` module (development, tests),
 * `nvml-worker.mjs` next to the bundle (`.output/server/index.mjs`, `app/build/server.ts`).
 */
export const workerPath = (moduleUrl: string): string =>
  decodeURIComponent(new URL(Str.endsWith('.ts')(moduleUrl) ? './worker.ts' : './nvml-worker.mjs', moduleUrl).pathname);

/** The NVML reader: an NVIDIA reader that also tells the driver's versions. */
export interface NvmlReader extends NvidiaReader {
  readonly system: Effect.Effect<NvmlSystem | null>;
}

/** How long the end of the sampler waits for its reader: its last messages are not lost. */
const DRAIN_TIMEOUT = '1 second';

/**
 * Starts the sampler (`command`, else `node worker.ts` next to this module) in a scope of its own forked from the
 * caller's, and waits for its `ready` up to `readyTimeout` (3 s): none, the sampler killed, on a timeout, an `error`
 * or an exit before it. After `ready`, each sample updates the state; an `error` or an exit clears the readings for
 * good (no restart, no switch to nvidia-smi). The end of the caller's scope kills the sampler with SIGKILL, at once.
 */
export const startNvml = Effect.fn('startNvml')(function* (options: {
  readonly intervalMs: number;
  readonly needs: GpuNeeds;
  readonly lib: Option.Option<string>;
  readonly command?: { readonly cmd: string; readonly args: ReadonlyArray<string> };
  readonly readyTimeout?: Duration.Input;
}) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const scope = yield* Effect.scope;
  const own = yield* Scope.fork(scope);
  const command = options.command ?? {
    cmd: process.execPath,
    // `node:ffi` is experimental: its warning would print on every start.
    args: ['--disable-warning=ExperimentalWarning', workerPath(import.meta.url)],
  };
  const spawned = yield* spawner
    .spawn(
      ChildProcess.make(command.cmd, command.args, {
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'inherit',
        // A sampler stuck in the driver is not asked to stop.
        killSignal: 'SIGKILL',
      }),
    )
    .pipe(Scope.provide(own), Effect.result);
  if (spawned._tag === 'Failure') {
    yield* Scope.close(own, Exit.void);
    return Option.none<NvmlReader>();
  }
  const handle = spawned.success;

  const outbox = yield* Queue.unbounded<ToSampler, Cause.Done>();
  yield* Stream.fromQueue(outbox).pipe(
    Stream.pipeThroughChannel(Ndjson.encodeSchemaString(ToSampler)()),
    Stream.encodeText,
    Stream.run(handle.stdin),
    Effect.ignore,
    Effect.forkIn(own),
  );

  const state = yield* Ref.make<NvmlState>({
    gpus: [],
    procs: [],
    system: null,
    lastSampleAt: 0,
    intervalMs: options.intervalMs,
    freshIntervalMs: options.intervalMs,
    dead: false,
  });
  /** true on `ready`, false on an `error` or an exit before it. */
  const ready = yield* Deferred.make<boolean>();
  const die = Ref.update(state, onDeath).pipe(Effect.andThen(Deferred.succeed(ready, false)));

  const onMessage = (message: FromSampler) =>
    Effect.gen(function* () {
      if (message.type === 'ready') return yield* Deferred.succeed(ready, true);
      if (message.type === 'error') {
        yield* die;
        // Gone for good: the end of its stdin would end it, the kill does it at once.
        return yield* handle.kill({ killSignal: 'SIGKILL' }).pipe(Effect.ignore, Effect.forkIn(scope));
      }
      const now = yield* Clock.currentTimeMillis;
      return yield* Ref.update(state, onSample(message.snapshot, now));
    });

  const drained = yield* Deferred.make<void>();
  yield* handle.stdout.pipe(
    Stream.pipeThroughChannel(Ndjson.decodeSchema(FromSampler)({ ignoreEmptyLines: true })),
    Stream.runForEach(onMessage),
    Effect.ignore,
    Effect.ensuring(Deferred.succeed(drained, undefined)),
    Effect.forkIn(own),
  );
  // Once it exits, its reader is joined (1 s at most): then it is dead, and its scope is closed.
  yield* handle.exitCode.pipe(
    Effect.ignore,
    Effect.andThen(Deferred.await(drained).pipe(Effect.interruptible, Effect.timeoutOption(DRAIN_TIMEOUT))),
    Effect.andThen(die),
    Effect.andThen(Scope.close(own, Exit.void)),
    Effect.forkIn(scope),
  );

  yield* Queue.offer(outbox, {
    type: 'start',
    intervalMs: options.intervalMs,
    needs: options.needs,
    ...Option.match(options.lib, { onNone: () => ({}), onSome: (lib) => ({ lib }) }),
  });
  const answered = yield* Deferred.await(ready).pipe(
    Effect.timeoutOption(options.readyTimeout ?? '3 seconds'),
    Effect.map(Option.getOrElse(() => false)),
  );
  if (!answered) {
    yield* Scope.close(own, Exit.void);
    return Option.none<NvmlReader>();
  }

  /** The state when its readings are recent; none when they are stale. */
  const fresh = Effect.gen(function* () {
    const s = yield* Ref.get(state);
    const now = yield* Clock.currentTimeMillis;
    return isFresh(s, now) ? Option.some(s) : Option.none();
  });

  const configure = Effect.fn('Nvml.configure')(function* (o: {
    readonly intervalMs: number;
    readonly needs: GpuNeeds;
  }) {
    yield* Ref.update(state, onConfigure(o.intervalMs));
    yield* Queue.offer(outbox, { type: 'configure', intervalMs: o.intervalMs, needs: o.needs });
  });

  const procVram = Effect.fn('Nvml.procVram')(function* (pid: number) {
    const s = yield* fresh;
    return Option.match(s, {
      onNone: (): ReadonlyMap<string, number> => new Map(),
      onSome: procVramOf(pid),
    });
  });

  return Option.some<NvmlReader>({
    gpus: fresh.pipe(Effect.map(Option.match({ onNone: () => [], onSome: (s) => s.gpus }))),
    procVram,
    // The processes come with each sample.
    refreshApps: Effect.void,
    configure,
    system: Ref.get(state).pipe(Effect.map((s) => s.system)),
  });
});
