import {
  Array as Arr,
  Effect,
  FileSystem,
  Number as Num,
  Option,
  Order,
  Path,
  Record as Rec,
  String as Str,
} from 'effect';
import { ChildProcess, ChildProcessSpawner } from 'effect/process';
import { which } from '../bench/which.ts';
import { resolveModelDisk } from '../collectors/disk.ts';
import { readTrimmed } from '../collectors/read.ts';
import type { SysReadings } from './checks.ts';

/** How long `git log` may take to give the build date. */
const GIT_TIMEOUT = '5 seconds';

/** How many levels above the binary's folder a git checkout is looked for (`build/bin/llama-server`). */
const GIT_DEPTH = 4;

/** The entries of a folder, None when it cannot be read. */
const listDir = (dir: string) => Effect.flatMap(FileSystem.FileSystem, (fs) => Effect.option(fs.readDirectory(dir)));

/** The entries of a folder, none when it cannot be read. */
const namesIn = (dir: string) => Effect.map(listDir(dir), Option.getOrElse(Arr.empty<string>));

/**
 * The absolute, symlink-free path of a binary: a bare name is looked up in the `PATH`, a relative path is taken from
 * the working folder. None when it cannot be found.
 */
export const resolveBinary = Effect.fn('tuning.resolveBinary')(function* (binary: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const found = Str.includes('/')(binary) ? Option.some(binary) : yield* which(binary);
  if (Option.isNone(found)) return Option.none<string>();
  return yield* Effect.option(fs.realPath(path.resolve(found.value)));
});

/** The git checkout holding `dir` (the folder itself or one of its parents, up to `GIT_DEPTH` levels). */
const gitRoot = Effect.fn('tuning.gitRoot')(function* (dir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  let current = dir;
  for (let i = 0; i < GIT_DEPTH; i++) {
    const exists = yield* fs.exists(path.join(current, '.git')).pipe(Effect.orElseSucceed(() => false));
    if (exists) return Option.some(current);
    const up = path.dirname(current);
    if (up === current) break;
    current = up;
  }
  return Option.none<string>();
});

/** The date of the last commit of `repo`, in ms; None when git fails, says nothing, or takes over `GIT_TIMEOUT`. */
const lastCommitMs = Effect.fn('tuning.lastCommitMs')(function* (repo: string) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const out = yield* spawner
    .string(
      ChildProcess.make('git', ['-C', repo, 'log', '-1', '--format=%ct'], {
        stdin: 'ignore',
        stderr: 'ignore',
        forceKillAfter: '1 second',
      }),
    )
    .pipe(Effect.timeoutOption(GIT_TIMEOUT), Effect.orElseSucceed(Option.none<string>));
  return Option.flatMap(out, (text) => {
    const seconds = Number(Str.trim(text));
    return Number.isFinite(seconds) && seconds > 0 ? Option.some(seconds * 1000) : Option.none<number>();
  });
});

/** The largest of the first six BARs of a PCI `resource` file (the VRAM aperture); 0 when there is none. */
export const largestBar = (resource: string | null): number => {
  if (resource === null) return 0;
  const sizes = Arr.getSomes(
    Arr.map(Arr.take(Str.split(resource, '\n'), 6), (line) => {
      const [start, end] = Str.split(Str.trim(line), /\s+/);
      if (start === undefined || end === undefined || start === '' || end === '') return Option.none<number>();
      return Option.liftThrowable(() => Number(BigInt(end) - BigInt(start) + 1n))();
    }),
  );
  return Arr.reduce(sizes, 0, (max, size) => Math.max(max, size));
};

/** The type of the filesystem mounted at the longest mount point of `/proc/mounts` that covers `path`. */
export const fsTypeOf = (options: { readonly mounts: string | null; readonly path: string }): string | null => {
  const { mounts, path } = options;
  if (mounts === null) return null;
  const covering = Arr.getSomes(
    Arr.map(Str.split(mounts, '\n'), (line) => {
      const [, point, type] = Str.split(line, /\s+/);
      if (point === undefined || type === undefined || point === '' || type === '') return Option.none();
      const covers = point === '/' || path === point || Str.startsWith(`${point}/`)(path);
      return covers ? Option.some({ point, type }) : Option.none();
    }),
  );
  // The first of the longest, as a strict `>` over the lines keeps it.
  const best = Arr.reduce(covering, Option.none<{ readonly point: string; readonly type: string }>(), (acc, m) =>
    Option.isNone(acc) || m.point.length > acc.value.point.length ? Option.some(m) : acc,
  );
  return Option.match(best, { onNone: () => null, onSome: (m) => m.type });
};

/** The number of a `cpuN` folder name. */
const cpuIndex = (name: string): number => Number(Str.slice(3)(name));

const byCpuIndex = Order.mapInput(Num.Order, cpuIndex);

export interface SysOptions {
  readonly procRoot?: string;
  readonly sysRoot?: string;
  /** The `binary` setting, `~` already expanded. */
  readonly binary: string;
  readonly modelPath: string | null;
  readonly logLines: ReadonlyArray<{ readonly text: string }>;
  /** The driver's versions NVML gives; null (or missing) with nvidia-smi. */
  readonly nvml?: { readonly driver: string | null; readonly cudaDriver: number | null } | null;
  /** PCI bus ids of the GPUs to look at (BAR1, DPM); every AMD card when missing. */
  readonly busIds?: ReadonlyArray<string>;
}

/** Every reading the system checks need; each one tolerant (null or empty when unreadable), never a failure. */
export const readSys = Effect.fn('tuning.readSys')(function* (options: SysOptions) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const proc = options.procRoot ?? '/proc';
  const sys = options.sysRoot ?? '/sys';
  const text = (file: string) => readTrimmed(file);
  const textOr = (file: string, fallback: string) => Effect.map(text(file), (t) => t ?? fallback);

  const cpuDir = path.join(sys, 'devices/system/cpu');
  const cpuNames = yield* namesIn(cpuDir);
  const cpus = Arr.sort(
    Arr.filter(cpuNames, (n) => /^cpu\d+$/.test(n)),
    byCpuIndex,
  );
  const governorReads = yield* Effect.forEach(cpus, (c) =>
    Effect.map(text(path.join(cpuDir, c, 'cpufreq/scaling_governor')), Option.fromNullishOr),
  );
  const governors = Arr.getSomes(governorReads);

  const thpRaw = yield* text(path.join(sys, 'kernel/mm/transparent_hugepage/enabled'));
  const thp = thpRaw === null || thpRaw === '' ? null : (/\[(\w+)\]/.exec(thpRaw)?.[1] ?? thpRaw);
  const limits = yield* text(path.join(proc, 'self/limits'));
  const memlockRaw = limits === null || limits === '' ? undefined : /^Max locked memory\s+(\S+)/m.exec(limits)?.[1];
  const memlockLimitBytes =
    memlockRaw === undefined ? null : memlockRaw === 'unlimited' ? Number.POSITIVE_INFINITY : Number(memlockRaw);
  const swapRaw = yield* text(path.join(proc, 'sys/vm/swappiness'));
  const swappiness = swapRaw === null || Number.isNaN(Number(swapRaw)) ? null : Number(swapRaw);
  const cmdline = yield* textOr(path.join(proc, 'cmdline'), '');
  const iommuEntries = yield* listDir(path.join(sys, 'class/iommu'));
  const iommuActive = Option.match(iommuEntries, { onNone: () => null, onSome: Arr.isReadonlyArrayNonEmpty });
  const moduleList = yield* textOr(path.join(proc, 'modules'), '');
  const modules = Arr.filter(
    Arr.map(Str.split(moduleList, '\n'), (l) => Str.split(l, /\s+/)[0] ?? ''),
    Str.isNonEmpty,
  );

  const binary = yield* resolveBinary(options.binary);
  const binaryDir = Option.map(binary, (b) => path.dirname(b));
  const besideBinary = Option.isNone(binaryDir) ? [] : yield* namesIn(binaryDir.value);
  const backendLibs = Arr.sort(
    Arr.filter(besideBinary, (n) => /^libggml-.*\.so/.test(n)),
    Order.String,
  );
  const repo = Option.isNone(binaryDir) ? Option.none<string>() : yield* gitRoot(binaryDir.value);
  const commitMs = Option.isNone(repo) ? Option.none<number>() : yield* lastCommitMs(repo.value);
  const buildDate = Option.getOrNull(commitMs);

  const moduleVersion = yield* text(path.join(sys, 'module/nvidia/version'));
  const driver = options.nvml?.driver ?? moduleVersion;
  const cudaDriver = options.nvml?.cudaDriver ?? null;

  const busIds = options.busIds ?? [];
  const bars = yield* Effect.forEach(busIds, (bus) =>
    Effect.map(text(path.join(sys, 'bus/pci/devices', bus, 'resource')), (r) => [bus, largestBar(r)] as const),
  );
  const bar1Bytes = Rec.fromEntries(Arr.filter(bars, ([, size]) => size > 0));

  const drm = path.join(sys, 'class/drm');
  const drmNames = yield* namesIn(drm);
  const cards = Arr.filter(drmNames, (n) => /^card\d+$/.test(n));
  const dpm = yield* Effect.forEach(cards, (card) =>
    Effect.gen(function* () {
      const real = yield* Effect.option(fs.realPath(path.join(drm, card, 'device')));
      if (Option.isNone(real)) return Option.none();
      const bus = path.basename(real.value);
      if (options.busIds !== undefined && !Arr.contains(busIds, bus)) return Option.none();
      const file = path.join(drm, card, 'device/power_dpm_force_performance_level');
      const level = yield* text(file);
      return level === null ? Option.none() : Option.some([bus, { level, path: file }] as const);
    }),
  );
  const amdDpm = Rec.fromEntries(Arr.getSomes(dpm));

  const systemInfo = Option.getOrNull(
    Option.map(
      Arr.findLast(options.logLines, (l) => Str.includes('system_info:')(l.text)),
      (l) => l.text,
    ),
  );
  const cudaDriverError = Arr.some(options.logLines, (l) => /driver version is insufficient/i.test(l.text));

  let modelDisk: SysReadings['modelDisk'] = null;
  if (options.modelPath !== null && options.modelPath !== '') {
    const disk = yield* resolveModelDisk(options.modelPath, { sysRoot: sys });
    const rot = Option.isNone(disk) ? null : yield* text(path.join(sys, 'block', disk.value, 'queue/rotational'));
    const mounts = yield* text(path.join(proc, 'mounts'));
    modelDisk = {
      rotational: rot === null ? null : rot === '1',
      fsType: fsTypeOf({ mounts, path: options.modelPath }),
    };
  }

  const readings: SysReadings = {
    governors,
    thp,
    memlockLimitBytes,
    swappiness,
    cmdline,
    iommuActive,
    modules,
    backendLibs,
    driver,
    cudaDriver,
    bar1Bytes,
    amdDpm,
    buildDate,
    systemInfo,
    cudaDriverError,
    modelDisk,
  };
  return readings;
});
