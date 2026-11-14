import type { GpuReading } from '@llama-webui/shared';
import {
  Array as Arr,
  Deferred,
  Duration,
  Effect,
  Option,
  Scope,
  String as Str,
  Stream,
  SynchronizedRef,
} from 'effect';
import { ChildProcess, ChildProcessSpawner } from 'effect/process';
import { linesOf } from '../logs/lines.ts';
import { closeWithin, FORCE_KILL_AFTER, type Followed, followProgram } from '../process/followed.ts';
import { type NvidiaReader, normalizeBusId } from './gpu.ts';

/*
 * The NVIDIA fallback when NVML cannot be loaded: one long-lived `nvidia-smi -lms` stream for the cards, and a
 * `--query-compute-apps` query now and then for the VRAM of each process.
 */

const MiB = 1024 ** 2;
const QUERY = 'index,uuid,name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw,pci.bus_id';

/** How long a caller of the compute-apps query waits past its timeout for the program to be gone. */
const KILL_GRACE = Duration.seconds(1);

const numOrNull = (s: string | undefined): number | null => {
  if (s === undefined) return null;
  const t = Str.trim(s);
  const n = Number(t);
  return t === '' || !Number.isFinite(n) ? null : n;
};

/** One line of `nvidia-smi --query-gpu=… --format=csv,noheader,nounits`; none for anything else. */
export const parseNvidiaGpuLine = (line: string): Option.Option<GpuReading> => {
  const f = Arr.map(Str.split(line, ','), Str.trim);
  const [, uuid = '', name = '', util, used, total, temp, power, bus = ''] = f;
  const usedN = numOrNull(used);
  const totalN = numOrNull(total);
  if (f.length < 9 || !Str.startsWith('GPU-')(uuid) || usedN === null || totalN === null) return Option.none();
  return Option.some({
    key: `nvidia:${uuid}`,
    vendor: 'nvidia',
    name,
    busId: normalizeBusId(bus),
    utilPct: numOrNull(util),
    vramUsedBytes: usedN * MiB,
    vramTotalBytes: totalN * MiB,
    tempC: numOrNull(temp),
    powerW: numOrNull(power),
  });
};

/** A process on a card. `usedBytes` null: the driver reports `[N/A]` (the process is on the card, its share unknown). */
export interface ComputeApp {
  readonly pid: number;
  readonly uuid: string;
  readonly usedBytes: number | null;
}

/** The output of `nvidia-smi --query-compute-apps=pid,gpu_uuid,used_memory --format=csv,noheader,nounits`. */
export const parseComputeApps = (csv: string): ReadonlyArray<ComputeApp> =>
  Arr.flatMap(Str.split(csv, '\n'), (line): ReadonlyArray<ComputeApp> => {
    const [pid = '', uuid = '', used = ''] = Arr.map(Str.split(line, ','), Str.trim);
    const p = Number(pid);
    const u = Number(used);
    if (uuid === '' || pid === '' || !Number.isFinite(p)) return [];
    if (used !== '' && Number.isFinite(u)) return [{ pid: p, uuid, usedBytes: u * MiB }];
    if (used === '[N/A]' || used === 'N/A') return [{ pid: p, uuid, usedBytes: null }];
    return [];
  });

/** The `nvidia-smi` reader: an NVIDIA reader whose stream starts on `start`. */
export interface NvidiaSmi extends NvidiaReader {
  /** false once nvidia-smi could not be launched: it is not tried again. */
  readonly available: Effect.Effect<boolean>;
  /** Starts the stream of the cards, once (nothing when it runs or nvidia-smi is unavailable). */
  readonly start: Effect.Effect<void>;
}

/** A launched stream: what its reader compares to know it is still the current one. */
type SmiStream = Followed;

interface Held {
  readonly intervalMs: number;
  /** The stream launched last, kept once it ended: a new interval launches it again. */
  readonly stream: Option.Option<SmiStream>;
  /** The last complete cycle of the stream: one line per card. */
  readonly current: ReadonlyArray<GpuReading>;
  /** The lines of the cycle being read. */
  readonly pending: ReadonlyArray<GpuReading>;
  readonly apps: ReadonlyArray<ComputeApp>;
  readonly available: boolean;
}

/** The pending cycle becomes the current one. */
const flush = (h: Held): Held => (h.pending.length === 0 ? h : { ...h, current: h.pending, pending: [] });

/** A line of the stream: a key seen again starts a new cycle; a cycle as long as the last one is complete. */
const onLine = (h: Held, g: GpuReading): Held => {
  const seen = Arr.some(h.pending, (p) => p.key === g.key) ? flush(h) : h;
  const next = { ...seen, pending: Arr.append(seen.pending, g) };
  return next.current.length > 0 && next.pending.length >= next.current.length ? flush(next) : next;
};

/** The cards of the last cycle, or of the first one while it is read. */
const gpusOf = (h: Held): ReadonlyArray<GpuReading> =>
  h.current.length === 0 && h.pending.length > 0 ? h.pending : h.current;

/**
 * `nvidia-smi` as an NVIDIA reader: one long-lived `nvidia-smi --query-gpu=… -lms <interval>` in a scope of its own,
 * its lines grouped into cycles, the last cycle kept when it dies (it is not restarted). A launch that fails makes it
 * unavailable for good. The compute-apps query runs one at a time under `appsTimeout` (3 s; the timeout kills it).
 * The end of the caller's scope stops it.
 */
export const makeNvidiaSmi = Effect.fn('makeNvidiaSmi')(function* (options: {
  readonly bin: string;
  readonly intervalMs: number;
  readonly appsTimeout?: Duration.Input;
}) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const context = yield* Effect.context<ChildProcessSpawner.ChildProcessSpawner>();
  const appsTimeout = Duration.fromInputUnsafe(options.appsTimeout ?? '3 seconds');
  // The streams and their watchers live in a scope the end of the caller's scope closes, every program at once.
  const scope = yield* Effect.scope;
  const ops = yield* Scope.fork(scope, 'parallel');
  /** Completed once the compute-apps query in flight ended; none before the first one. */
  const inFlight = yield* SynchronizedRef.make<Option.Option<Deferred.Deferred<void>>>(Option.none());
  const held = yield* SynchronizedRef.make<Held>({
    intervalMs: options.intervalMs,
    stream: Option.none(),
    current: [],
    pending: [],
    apps: [],
    available: true,
  });

  const isMine = (stream: SmiStream) => (h: Held) => Option.exists(h.stream, (s) => s === stream);

  /** What the stream prints, line by line, while it is the current one; its end completes the last cycle. */
  const read = (stream: SmiStream, stdout: Stream.Stream<Uint8Array, unknown>) =>
    linesOf(stdout).pipe(
      Stream.runForEach((line) =>
        Option.match(parseNvidiaGpuLine(line), {
          onNone: () => Effect.void,
          onSome: (g) => SynchronizedRef.update(held, (h) => (isMine(stream)(h) ? onLine(h, g) : h)),
        }),
      ),
      Effect.andThen(SynchronizedRef.update(held, (h) => (isMine(stream)(h) ? flush(h) : h))),
      // A stream cut short keeps the last values.
      Effect.ignore,
    );

  /** Launches the stream at `h.intervalMs`; a launch that fails makes nvidia-smi unavailable. */
  const launch = (h: Held): Effect.Effect<Held> =>
    followProgram({
      command: ChildProcess.make(
        options.bin,
        [`--query-gpu=${QUERY}`, '--format=csv,noheader,nounits', '-lms', String(h.intervalMs)],
        { stdin: 'ignore', stderr: 'ignore', forceKillAfter: FORCE_KILL_AFTER },
      ),
      parent: ops,
      name: 'nvidia-smi',
      read: (stream) => read(stream, stream.handle.stdout),
    }).pipe(
      Effect.match({
        onFailure: (): Held => ({ ...h, stream: Option.none(), available: false }),
        onSuccess: (stream): Held => ({ ...h, stream: Option.some(stream), pending: [] }),
      }),
      Effect.provideContext(context),
    );

  /** Stops a stream without waiting for it: its reader no longer counts once the state names another one. */
  const stop = (stream: SmiStream) => Effect.forkIn(stream.stop, ops).pipe(Effect.asVoid);

  /** A change of the state that may launch a stream: uninterruptible, so no stream runs that the state does not name. */
  const changeStream = (f: (h: Held) => Effect.Effect<Held>) =>
    Effect.uninterruptible(SynchronizedRef.updateEffect(held, f));

  const start = changeStream((h) => (Option.isSome(h.stream) || !h.available ? Effect.succeed(h) : launch(h))).pipe(
    Effect.withSpan('NvidiaSmi.start'),
  );

  /**
   * A new interval restarts the stream at that pace. Every card is still queried, hidden ones included: one call reads
   * them all and reads no PCIe throughput; the monitor only identifies the hidden ones.
   */
  const configure = Effect.fn('NvidiaSmi.configure')(function* (o: { readonly intervalMs: number }) {
    yield* changeStream((h) => {
      if (o.intervalMs === h.intervalMs) return Effect.succeed(h);
      const next = { ...h, intervalMs: o.intervalMs };
      return Option.match(h.stream, {
        onNone: () => Effect.succeed(next),
        onSome: (stream) => stop(stream).pipe(Effect.andThen(launch(next))),
      });
    });
  });

  /**
   * The compute-apps query, its mapping kept when it gives one (not on a timeout, which kills it, a failure or a
   * non-zero exit). Its program runs in a scope of its own, closed within the bound of `closeWithin`; `gone` completes
   * once the program really is gone, a hung one (stuck in the driver) included.
   */
  const queryApps = (gone: Deferred.Deferred<void>) =>
    Effect.acquireUseRelease(
      Scope.make(),
      (own) =>
        Effect.gen(function* () {
          const spawned = yield* spawner
            .spawn(
              ChildProcess.make(
                options.bin,
                ['--query-compute-apps=pid,gpu_uuid,used_memory', '--format=csv,noheader,nounits'],
                {
                  stdin: 'ignore',
                  stderr: 'ignore',
                  // A hung nvidia-smi (a driver fault) is not asked to stop.
                  killSignal: 'SIGKILL',
                },
              ),
            )
            .pipe(Scope.provide(own), Effect.result);
          if (spawned._tag === 'Failure') {
            yield* SynchronizedRef.update(held, (h) => ({ ...h, available: false }));
            return;
          }
          const handle = spawned.success;
          const text = yield* Effect.all([Stream.mkString(Stream.decodeText(handle.stdout)), handle.exitCode], {
            concurrency: 2,
          }).pipe(
            Effect.timeoutOption(appsTimeout),
            Effect.map(Option.flatMap(([out, code]) => (code === 0 ? Option.some(out) : Option.none()))),
            Effect.orElseSucceed(() => Option.none<string>()),
          );
          if (Option.isSome(text))
            yield* SynchronizedRef.update(held, (h) => ({ ...h, apps: parseComputeApps(text.value) }));
        }),
      (own) =>
        closeWithin({
          scope: own,
          name: 'nvidia-smi --query-compute-apps',
          onClosed: Deferred.succeed(gone, undefined),
        }),
    );

  /**
   * One query at a time: a call while one runs waits for that same query. The query runs in a fiber of its own, so a
   * caller waits `appsTimeout` and the kill's grace at most, even for a program the kill cannot end yet (stuck in the
   * driver); the next query starts once it is gone, so stuck queries do not pile up. The previous mapping stays when
   * the query gives none.
   */
  const refreshApps = Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const { available } = yield* SynchronizedRef.get(held);
      if (!available) return;
      const done = yield* SynchronizedRef.modifyEffect(inFlight, (running) =>
        Effect.gen(function* () {
          if (Option.isSome(running) && !(yield* Deferred.isDone(running.value)))
            return [running.value, running] as const;
          const gone = yield* Deferred.make<void>();
          yield* Effect.forkIn(queryApps(gone), ops);
          return [gone, Option.some(gone)] as const;
        }),
      );
      yield* restore(Deferred.await(done).pipe(Effect.timeoutOption(Duration.sum(appsTimeout, KILL_GRACE))));
    }),
  ).pipe(Effect.withSpan('NvidiaSmi.refreshApps'));

  const procVram = Effect.fn('NvidiaSmi.procVram')(function* (pid: number) {
    const h = yield* SynchronizedRef.get(held);
    const m = new Map<string, number>();
    const unknown = new Set<string>();
    for (const a of h.apps) {
      if (a.pid !== pid) continue;
      const k = `nvidia:${a.uuid}`;
      if (a.usedBytes === null) unknown.add(k);
      else m.set(k, (m.get(k) ?? 0) + a.usedBytes);
    }
    // Share unknown: count the card's VRAM in use (an upper bound) so the card still shows as used.
    for (const k of unknown) {
      const card = Arr.findFirst(gpusOf(h), (g) => g.key === k);
      m.set(k, Option.isSome(card) ? card.value.vramUsedBytes : (m.get(k) ?? 0));
    }
    return m as ReadonlyMap<string, number>;
  });

  return {
    gpus: SynchronizedRef.get(held).pipe(Effect.map(gpusOf)),
    procVram,
    refreshApps,
    configure,
    available: SynchronizedRef.get(held).pipe(Effect.map((h) => h.available)),
    start,
  } satisfies NvidiaSmi as NvidiaSmi;
});
