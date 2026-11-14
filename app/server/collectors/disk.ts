import type { DiskSample } from '@llama-webui/shared';
import { Array as Arr, Clock, Effect, FileSystem, Option, Order, Path, Ref, String as Str } from 'effect';
import { pipe } from 'effect/Function';
import { readText } from './read.ts';

const SECTOR = 512;

interface Counters {
  readonly readBytes: number;
  readonly writeBytes: number;
}

/** `/proc/diskstats`: field 6 is the sectors read, field 10 the sectors written (always 512-byte units). */
export const parseDiskstats = (text: string): Map<string, Counters> => {
  const out = new Map<string, Counters>();
  for (const line of Str.split(text, '\n')) {
    const f = pipe(line, Str.trim, Str.split(/\s+/));
    if (f.length < 10) continue;
    const r = Number(f[5]);
    const w = Number(f[9]);
    if (!Number.isFinite(r) || !Number.isFinite(w)) continue;
    out.set(f[2] ?? '', { readBytes: r * SECTOR, writeBytes: w * SECTOR });
  }
  return out;
};

/** Whole physical disks: the `/sys/block` entries backed by a device, minus loop, ram and zram. */
export const physicalDisks = (sysBlockRoot = '/sys/block') =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const entries = yield* fs.readDirectory(sysBlockRoot).pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
    const real = Arr.filter(entries, (entry) => !/^(loop|ram|zram)\d/.test(entry));
    const backed = yield* Effect.filter(real, (entry) =>
      fs.stat(path.join(sysBlockRoot, entry, 'device')).pipe(Effect.isSuccess),
    );
    return Arr.sort(backed, Order.String);
  });

/** glibc `gnu_dev_major` and `gnu_dev_minor`. */
export const devMajorMinor = (dev: bigint): readonly [number, number] => {
  const major = ((dev >> 8n) & 0xfffn) | ((dev >> 32n) & ~0xfffn);
  const minor = (dev & 0xffn) | ((dev >> 12n) & ~0xffn);
  return [Number(major), Number(minor)];
};

/**
 * The disk holding a file (a partition resolves to its disk), from the device number `stat` gives. None for a
 * missing file and for a filesystem with no block device (tmpfs, btrfs, NFS: major 0).
 */
export const resolveModelDisk = Effect.fn('disk.resolveModelDisk')(function* (
  file: string,
  options: { readonly sysRoot?: string } = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const info = yield* fs.stat(file).pipe(Effect.option);
  if (Option.isNone(info)) return Option.none<string>();
  const [major, minor] = devMajorMinor(info.value.dev);
  if (major === 0) return Option.none<string>();
  const real = yield* fs
    .realPath(path.join(options.sysRoot ?? '/sys', 'dev/block', `${major}:${minor}`))
    .pipe(Effect.option);
  if (Option.isNone(real)) return Option.none<string>();
  const partition = yield* fs.exists(path.join(real.value, 'partition')).pipe(Effect.orElseSucceed(() => false));
  return Option.some(partition ? path.basename(path.dirname(real.value)) : path.basename(real.value));
});

interface Previous {
  readonly at: number;
  readonly counters: Map<string, Counters>;
}

/** The disks' read and write rates against the previous sample and the `Clock`; 0 on the first sample. */
export const makeDiskSampler = Effect.fn('DiskSampler.make')(function* (options: {
  readonly disks: ReadonlyArray<string>;
  readonly procRoot?: string;
}) {
  const path = yield* Path.Path;
  const procRoot = options.procRoot ?? '/proc';
  const prev = yield* Ref.make(Option.none<Previous>());

  const sample = Effect.fn('DiskSampler.sample')(function* (modelDisk: string | null) {
    const text = yield* readText(path.join(procRoot, 'diskstats'));
    const counters = text === null ? new Map<string, Counters>() : parseDiskstats(text);
    const at = yield* Clock.currentTimeMillis;
    const before = yield* Ref.getAndSet(prev, Option.some({ at, counters }));
    const dt = Option.match(before, { onNone: () => 0, onSome: (p) => (at - p.at) / 1000 });
    const rate = (disk: string, field: keyof Counters): number => {
      const c = counters.get(disk)?.[field];
      const p = Option.getOrUndefined(before)?.counters.get(disk)?.[field];
      return c === undefined || p === undefined || dt <= 0 ? 0 : Math.max(0, (c - p) / dt);
    };
    const perDisk: Record<string, { readBps: number; writeBps: number }> = {};
    let readBps = 0;
    let writeBps = 0;
    for (const d of options.disks) {
      const r = { readBps: rate(d, 'readBytes'), writeBps: rate(d, 'writeBytes') };
      perDisk[d] = r;
      readBps += r.readBps;
      writeBps += r.writeBps;
    }
    const model =
      modelDisk !== null && counters.has(modelDisk) ? { disk: modelDisk, readBps: rate(modelDisk, 'readBytes') } : null;
    return { readBps, writeBps, perDisk, model } satisfies DiskSample;
  });

  return { sample } as const;
});
