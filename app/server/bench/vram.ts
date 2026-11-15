import {
  Array as Arr,
  Duration,
  Effect,
  Fiber,
  FileSystem,
  Option,
  Path,
  Ref,
  Schedule,
  Scope,
  String as Str,
  Stream,
} from 'effect';
import { ChildProcess, type ChildProcessSpawner } from 'effect/process';
import { linesOf } from '../logs/lines.ts';
import { FORCE_KILL_AFTER, followProgram } from '../process/followed.ts';

const MIB = 1024 * 1024;
const SMI_LINE = /^\s*(GPU-[\w-]+),\s*(\d+)\s*$/;

/** A line of `nvidia-smi --query-gpu=uuid,memory.used --format=csv,noheader,nounits -lms N`, with the monitor's key. */
export const parseSmiLine = (line: string): Option.Option<{ readonly key: string; readonly bytes: number }> =>
  Option.flatMap(Option.fromNullishOr(SMI_LINE.exec(line)), (match) =>
    match[1] === undefined || match[2] === undefined
      ? Option.none()
      : Option.some({ key: `nvidia:${match[1]}`, bytes: Number(match[2]) * MIB }),
  );

/** What the probe needs of a GPU of the monitor. */
export interface ProbedGpu {
  readonly key: string;
  readonly vendor: 'nvidia' | 'amd';
  readonly busId: string;
  readonly vramTotalBytes: number;
}

/** The VRAM a card held at the first reading of the probe, and the most it held since. */
export interface VramReading {
  readonly first: number;
  readonly max: number;
}

/** A running probe. */
export interface VramProbe {
  readonly readings: Effect.Effect<ReadonlyMap<string, VramReading>>;
  /** Stops the sampling: nvidia-smi killed, the sysfs reads ended. */
  readonly stop: Effect.Effect<void>;
}

/**
 * Fast VRAM sampling during a run (the monitor reads at its interval, 1 s by default, and misses short peaks):
 * `nvidia-smi -lms` for NVIDIA cards, sysfs `mem_info_vram_used` for AMD ones, every `interval` (100 ms). A source that
 * fails is ignored: the executor keeps the monitor's snapshots as a fallback. Runs in the caller's scope.
 */
export const startVramProbe = Effect.fn('vram.startVramProbe')(function* (
  gpus: ReadonlyArray<ProbedGpu>,
  options: { readonly interval?: Duration.Input; readonly sysRoot?: string; readonly nvidiaSmi?: string } = {},
) {
  const scope = yield* Scope.Scope;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const interval = Duration.fromInputUnsafe(options.interval ?? '100 millis');
  const seen = yield* Ref.make<ReadonlyMap<string, VramReading>>(new Map());
  const note = (key: string, bytes: number) =>
    Ref.update(seen, (map) => {
      const was = map.get(key);
      if (was !== undefined && bytes <= was.max) return map;
      return new Map(map).set(key, was === undefined ? { first: bytes, max: bytes } : { ...was, max: bytes });
    });

  const smi = Arr.some(gpus, (g) => g.vendor === 'nvidia')
    ? yield* followProgram({
        command: ChildProcess.make(
          options.nvidiaSmi ?? 'nvidia-smi',
          [
            '--query-gpu=uuid,memory.used',
            '--format=csv,noheader,nounits',
            '-lms',
            `${Math.max(1, Duration.toMillis(interval))}`,
          ],
          { stdin: 'ignore', stderr: 'ignore', forceKillAfter: FORCE_KILL_AFTER },
        ),
        parent: scope,
        name: 'nvidia-smi',
        read: ({ handle }) =>
          linesOf(handle.stdout).pipe(
            Stream.runForEach((line) =>
              Option.match(parseSmiLine(line), {
                onNone: () => Effect.void,
                onSome: (reading) => note(reading.key, reading.bytes),
              }),
            ),
            Effect.ignore,
          ),
      }).pipe(Effect.option)
    : Option.none();

  const amd = Arr.filter(gpus, (g) => g.vendor === 'amd' && g.vramTotalBytes > 0);
  const sysRoot = options.sysRoot ?? '/sys';
  const tick = Effect.forEach(
    amd,
    (gpu) =>
      fs.readFileString(path.join(sysRoot, 'bus/pci/devices', gpu.busId, 'mem_info_vram_used')).pipe(
        Effect.map(Str.trim),
        Effect.flatMap((text) => {
          const bytes = Number(text);
          return text !== '' && Number.isFinite(bytes) ? note(gpu.key, bytes) : Effect.void;
        }),
        Effect.ignore,
      ),
    { discard: true },
  );
  const sysfs = Arr.isReadonlyArrayNonEmpty(amd)
    ? yield* tick.pipe(Effect.repeat(Schedule.spaced(interval)), Effect.forkIn(scope), Effect.asSome)
    : Option.none();

  const stop = Effect.gen(function* () {
    if (Option.isSome(sysfs)) yield* Fiber.interrupt(sysfs.value);
    if (Option.isSome(smi)) yield* smi.value.stop;
  });
  const probe: VramProbe = { readings: Ref.get(seen), stop };
  return probe;
});

/** The requirements of `startVramProbe`. */
export type VramProbeServices =
  | Scope.Scope
  | FileSystem.FileSystem
  | Path.Path
  | ChildProcessSpawner.ChildProcessSpawner;
