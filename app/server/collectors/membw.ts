import type { MemBandwidth } from '@llama-webui/shared';
import { Clock, Deferred, Duration, Effect, Exit, Option, Scope, String as Str, Stream, SynchronizedRef } from 'effect';
import { ChildProcess, ChildProcessSpawner } from 'effect/process';
import { linesOf } from '../logs/lines.ts';

/*
 * DRAM bandwidth through `perf stat`, without root when perf_event_paranoid ≤ 0 (or CAP_PERFMON on perf):
 * - whole system: AMD memory controller PMU (`umc_cas_cmd.rd/wr`, one CAS command = 64 bytes), which sees everything
 *   that touches DRAM (CPU, GPU DMA over PCIe, NVMe);
 * - llama-server alone: core event `ls_any_fills_from_sys.dram_io_all` (64-byte lines fetched from DRAM),
 *   attached to its PID.
 * Any failure (perf missing, event unknown on this CPU, insufficient permissions) degrades to “unknown”.
 */

export const SYSTEM_EVENTS = { read: 'umc_cas_cmd.rd', write: 'umc_cas_cmd.wr' } as const;
export const PROC_EVENT = 'ls_any_fills_from_sys.dram_io_all';
/** One CAS command or one line fill = 64 bytes. */
export const BYTES_PER_EVENT = 64;

/** How long the end of a stream waits for its reader. */
const DRAIN_TIMEOUT = '1 second';

/** The backstop of a stream scope closed on a live perf: SIGKILL that long after its SIGTERM. */
const FORCE_KILL_AFTER = '1 second';

export interface PerfLine {
  /** Seconds since perf was started. */
  readonly time: number;
  /** null: “<not supported>” or “<not counted>”. */
  readonly count: number | null;
  readonly event: string;
}

/** CSV line of `perf stat -I … -x,`: “1.005,1072663,,umc_cas_cmd.rd,2010102242,100,00,,”. */
export const parsePerfLine = (line: string): PerfLine | null => {
  const f = Str.split(line, ',');
  const [first = '', second = '', , fourth = ''] = f;
  if (f.length < 4) return null;
  const time = Number(first);
  if (!Number.isFinite(time)) return null;
  const event = Str.trim(fourth);
  if (event === '') return null;
  const n = Number(second);
  return { time, count: Str.startsWith('<')(second) || !Number.isFinite(n) ? null : n, event };
};

/** DRAM bandwidth through two `perf stat` streams, the machine's and the followed process's. */
export interface MemBandwidthSampler {
  /** The machine's DRAM bandwidth; null while perf does not report it. A dead stream is started again from here. */
  readonly sample: Effect.Effect<MemBandwidth | null>;
  /** Bytes/s the followed process fetched from DRAM; null if unknown. */
  readonly procSample: Effect.Effect<number | null>;
  /**
   * The process to follow (llama-server); null: none. Called on every tick: a PID perf could never attach to is not
   * retried, a stream that died after reporting values is started again no sooner than the retry delay.
   */
  readonly setPid: (pid: number | null) => Effect.Effect<void>;
  /** A new interval restarts both streams (perf sets its interval at launch). */
  readonly configure: (intervalMs: number) => Effect.Effect<void>;
}

/** One launched `perf stat` and what it reported: a rate (events/s) per event, from each interval's count. */
interface Perf {
  /** The scope of the process, its reader and nothing else; none when perf could not be launched. */
  readonly scope: Option.Option<Scope.Closeable>;
  readonly prevTime: ReadonlyMap<string, number>;
  readonly rates: ReadonlyMap<string, number>;
  /** When the last line came. */
  readonly lastAt: number;
  /** When perf exited or could not be launched; none while it runs. */
  readonly diedAt: Option.Option<number>;
  readonly gotData: boolean;
}

type Slot = 'system' | 'proc';

interface Held {
  readonly intervalMs: number;
  readonly system: Perf;
  readonly proc: Option.Option<Perf>;
  readonly pid: number | null;
}

const isDead = (p: Perf) => Option.isSome(p.diedAt);

/** perf refused to start, or exited without ever reporting anything. */
const hasFailed = (p: Perf) => isDead(p) && !p.gotData;

const onLine = (p: Perf, line: PerfLine, now: number): Perf => {
  const dt = line.time - (p.prevTime.get(line.event) ?? 0);
  const rates = new Map(p.rates);
  if (line.count === null || dt <= 0) rates.delete(line.event);
  else rates.set(line.event, line.count / dt);
  return { ...p, prevTime: new Map(p.prevTime).set(line.event, line.time), rates, lastAt: now, gotData: true };
};

/** The rate of `event` (per second) if a line came less than `maxAgeMs` ago. */
const rateOf = (p: Perf, event: string, maxAgeMs: number, now: number): number | null =>
  now - p.lastAt > maxAgeMs ? null : (p.rates.get(event) ?? null);

const slotOf = (h: Held, slot: Slot): Option.Option<Perf> => (slot === 'system' ? Option.some(h.system) : h.proc);

const withSlot = (h: Held, slot: Slot, p: Perf): Held =>
  slot === 'system' ? { ...h, system: p } : { ...h, proc: Option.some(p) };

/**
 * The DRAM bandwidth sampler: the system stream starts at once, the process stream on `setPid`; each runs in a scope
 * of its own. Values are stale after three intervals without a line; a dead or failing stream is started again no
 * sooner than `retryAfter` (60 s). The end of the caller's scope stops both.
 */
export const makeMemBandwidth = Effect.fn('makeMemBandwidth')(function* (options: {
  readonly bin?: string;
  readonly intervalMs: number;
  readonly retryAfter?: Duration.Input;
}) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const bin = options.bin ?? 'perf';
  const retryAfterMs = Duration.toMillis(Duration.fromInputUnsafe(options.retryAfter ?? '60 seconds'));
  // The streams and their watchers live in a scope the end of the caller's scope closes.
  const scope = yield* Effect.scope;
  const ops = yield* Scope.fork(scope);

  /** A perf never launched: dead from the start, so the first look launches it. */
  const unlaunched: Perf = {
    scope: Option.none(),
    prevTime: new Map(),
    rates: new Map(),
    lastAt: 0,
    diedAt: Option.some(0),
    gotData: false,
  };
  const held = yield* SynchronizedRef.make<Held>({
    intervalMs: options.intervalMs,
    system: unlaunched,
    proc: Option.none(),
    pid: null,
  });

  /** Updates the perf of `slot` while it is still the one of `stream`: a stream that was replaced changes nothing. */
  const updateIf = (slot: Slot, stream: Scope.Closeable, f: (p: Perf) => Perf) =>
    SynchronizedRef.update(held, (h) =>
      Option.match(slotOf(h, slot), {
        onNone: () => h,
        onSome: (p) => (Option.getOrUndefined(p.scope) === stream ? withSlot(h, slot, f(p)) : h),
      }),
    );

  /** Launches `perf stat <args> -I <interval>` for `slot`; a launch that fails is a perf dead at once. */
  const launch = (slot: Slot, args: ReadonlyArray<string>, intervalMs: number): Effect.Effect<Perf> =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const streamScope = yield* Scope.fork(ops);
      const spawned = yield* spawner
        .spawn(
          ChildProcess.make(bin, ['stat', ...args, '-I', String(intervalMs), '-x', ',', '--log-fd', '1'], {
            stdin: 'ignore',
            stderr: 'ignore',
            forceKillAfter: FORCE_KILL_AFTER,
          }),
        )
        .pipe(Scope.provide(streamScope), Effect.result);
      if (spawned._tag === 'Failure') {
        yield* Scope.close(streamScope, Exit.void);
        return { ...unlaunched, diedAt: Option.some(now) };
      }
      const handle = spawned.success;
      const perf: Perf = { ...unlaunched, scope: Option.some(streamScope), diedAt: Option.none() };
      const drained = yield* Deferred.make<void>();
      yield* linesOf(handle.stdout).pipe(
        Stream.runForEach((text) => {
          const line = parsePerfLine(text);
          return line === null
            ? Effect.void
            : Effect.flatMap(Clock.currentTimeMillis, (at) => updateIf(slot, streamScope, (p) => onLine(p, line, at)));
        }),
        // A stream cut short keeps its last values: they go stale.
        Effect.ignore,
        Effect.ensuring(Deferred.succeed(drained, undefined)),
        Effect.forkIn(streamScope),
      );
      // Once perf exits, its reader is joined (1 s at most), it is marked dead, then its scope is closed.
      yield* handle.exitCode.pipe(
        Effect.ignore,
        Effect.andThen(Deferred.await(drained).pipe(Effect.interruptible, Effect.timeoutOption(DRAIN_TIMEOUT))),
        Effect.andThen(Clock.currentTimeMillis),
        Effect.flatMap((at) => updateIf(slot, streamScope, (p) => ({ ...p, diedAt: Option.some(at) }))),
        Effect.andThen(Scope.close(streamScope, Exit.void)),
        Effect.forkIn(ops),
      );
      return perf;
    });

  /** Stops a stream without waiting for it. */
  const stop = (p: Perf) =>
    Option.match(p.scope, {
      onNone: () => Effect.void,
      onSome: (s) => Effect.forkIn(Scope.close(s, Exit.void), ops).pipe(Effect.asVoid),
    });

  const systemArgs = ['-a', '-e', `${SYSTEM_EVENTS.read},${SYSTEM_EVENTS.write}`];
  const procArgs = (pid: number) => ['-p', String(pid), '-e', PROC_EVENT];

  /** A dead stream can be started again `retryAfter` after it died (no spawn loop if perf fails every time). */
  const canRetry = (p: Perf, now: number) => Option.exists(p.diedAt, (at) => now - at >= retryAfterMs);

  const startSystem = (h: Held) =>
    stop(h.system).pipe(
      Effect.andThen(launch('system', systemArgs, h.intervalMs)),
      Effect.map((system): Held => ({ ...h, system })),
    );

  /** The process stream of `h` follows `pid`. */
  const follow = (h: Held, pid: number | null): Effect.Effect<Held> =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      let next = h;
      if (pid !== h.pid) {
        if (Option.isSome(h.proc)) yield* stop(h.proc.value);
        next = { ...h, proc: Option.none(), pid };
      }
      const p = next.proc;
      if (pid === null || (Option.isSome(p) && (hasFailed(p.value) || !canRetry(p.value, now)))) return next;
      if (Option.isSome(p)) yield* stop(p.value);
      const proc = yield* launch('proc', procArgs(pid), next.intervalMs);
      return { ...next, proc: Option.some(proc) };
    });

  yield* SynchronizedRef.updateEffect(held, startSystem);

  const sample = SynchronizedRef.modifyEffect(held, (h) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      if (isDead(h.system)) {
        const next = canRetry(h.system, now) ? yield* startSystem(h) : h;
        return [null, next] as const;
      }
      const maxAgeMs = h.intervalMs * 3;
      const read = rateOf(h.system, SYSTEM_EVENTS.read, maxAgeMs, now);
      const write = rateOf(h.system, SYSTEM_EVENTS.write, maxAgeMs, now);
      const bw: MemBandwidth | null =
        read === null && write === null
          ? null
          : { readBps: (read ?? 0) * BYTES_PER_EVENT, writeBps: (write ?? 0) * BYTES_PER_EVENT };
      return [bw, h] as const;
    }),
  ).pipe(Effect.withSpan('MemBandwidth.sample'));

  const procSample = Effect.gen(function* () {
    const h = yield* SynchronizedRef.get(held);
    const now = yield* Clock.currentTimeMillis;
    return Option.match(h.proc, {
      onNone: () => null,
      onSome: (p) => {
        if (isDead(p)) return null;
        const r = rateOf(p, PROC_EVENT, h.intervalMs * 3, now);
        return r === null ? null : r * BYTES_PER_EVENT;
      },
    });
  }).pipe(Effect.withSpan('MemBandwidth.procSample'));

  const setPid = Effect.fn('MemBandwidth.setPid')(function* (pid: number | null) {
    yield* SynchronizedRef.updateEffect(held, (h) => follow(h, pid));
  });

  const configure = Effect.fn('MemBandwidth.configure')(function* (intervalMs: number) {
    yield* SynchronizedRef.updateEffect(held, (h) =>
      h.intervalMs === intervalMs
        ? Effect.succeed(h)
        : Effect.gen(function* () {
            const withSystem = yield* startSystem({ ...h, intervalMs });
            // The process stream is replaced too: stopped, then started at the new interval for the same pid.
            const none = yield* follow(withSystem, null);
            return yield* follow(none, h.pid);
          }),
    );
  });

  return { sample, procSample, setPid, configure } satisfies MemBandwidthSampler as MemBandwidthSampler;
});
