import { NodeServices } from '@effect/platform-node';
import { assert, describe, it } from '@effect/vitest';
import {
  Array as Arr,
  ConfigProvider,
  Context,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Record as Rec,
  type Scope,
  String as Str,
} from 'effect';
import { ChildProcess, ChildProcessSpawner } from 'effect/process';
import { fsTypeOf, gfxName, kfdBusId, largestBar, readHipTargets, readSys, resolveBinary } from './sysinfo.ts';
import { TuningMemo } from './TuningMemo.ts';

type Services = FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner | Scope.Scope;

const fresh = <A, E>(test: Effect.Effect<A, E, Services>) =>
  Layer.build(NodeServices.layer).pipe(
    Effect.flatMap((context) => Effect.provideContext(test, context)),
    Effect.scoped,
  );

const MiB = 1024 ** 2;

/** A folder of the test's own, and a way to write a file in it (its folders made). */
const workspace = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = yield* fs.makeTempDirectoryScoped({ prefix: 'lw-sysinfo-' });
  const at = (name: string) => path.join(dir, name);
  const write = Effect.fn('write')(function* (name: string, text: string, mode?: number) {
    yield* fs.makeDirectory(path.dirname(at(name)), { recursive: true });
    yield* fs.writeFileString(at(name), text);
    if (mode !== undefined) yield* fs.chmod(at(name), mode);
    return at(name);
  });
  return { fs, path, dir, at, write };
});

/** A git checkout at `repo` with one empty commit dated `seconds`, the user's git configuration left out. */
const gitRepo = Effect.fn('gitRepo')(function* (repo: string, seconds: number) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const date = `@${seconds} +0000`;
  const env = {
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_DATE: date,
  };
  const git = (args: ReadonlyArray<string>) =>
    spawner.exitCode(
      ChildProcess.make('git', ['-C', repo, ...args], { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore', env }),
    );
  yield* git(['init', '-q']);
  yield* git(['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'x']);
});

const NO_LOGS: ReadonlyArray<{ readonly text: string }> = [];

describe('sysinfo', () => {
  it.effect('readSys reads every value from the /proc and /sys trees', () =>
    fresh(
      Effect.gen(function* () {
        const { fs, path, at, write } = yield* workspace;
        const sys = at('sys');
        const proc = at('proc');
        for (const [cpu, governor] of [
          ['cpu10', 'powersave'],
          ['cpu2', 'schedutil'],
          ['cpu0', 'performance'],
        ] as const) {
          yield* write(`sys/devices/system/cpu/${cpu}/cpufreq/scaling_governor`, `${governor}\n`);
        }
        yield* fs.makeDirectory(at('sys/devices/system/cpu/cpu1'), { recursive: true });
        yield* fs.makeDirectory(at('sys/devices/system/cpu/cpuidle'), { recursive: true });
        yield* write('sys/kernel/mm/transparent_hugepage/enabled', 'always [madvise] never\n');
        yield* write(
          'proc/self/limits',
          'Limit                     Soft Limit           Hard Limit           Units\nMax locked memory         8388608              8388608              bytes\n',
        );
        yield* write('proc/sys/vm/swappiness', '10\n');
        yield* write('proc/cmdline', 'BOOT_IMAGE=/vmlinuz iommu=pt\n');
        yield* fs.makeDirectory(at('sys/class/iommu/dmar0'), { recursive: true });
        yield* write('proc/modules', 'nvidia_uvm 2076672 0 - Live 0x0\nnvidia 14389248 1 nvidia_uvm, Live 0x0\n');
        yield* write('sys/module/nvidia/version', '580.95.05\n');
        yield* write(
          'sys/bus/pci/devices/0000:01:00.0/resource',
          '0x00000000f6000000 0x00000000f6ffffff 0x0000000000040200\n0x000000f800000000 0x000000ffffffffff 0x000000000014220c\n0x0000000000000000 0x0000000000000000 0x0000000000000000\n',
        );
        yield* write('sys/devices/pci0000:00/0000:08:00.0/power_dpm_force_performance_level', 'auto\n');
        yield* fs.makeDirectory(at('sys/devices/pci0000:00/0000:01:00.0'), { recursive: true });
        yield* fs.makeDirectory(at('sys/class/drm/card1'), { recursive: true });
        yield* fs.makeDirectory(at('sys/class/drm/card0'), { recursive: true });
        yield* fs.symlink(at('sys/devices/pci0000:00/0000:08:00.0'), at('sys/class/drm/card1/device'));
        yield* fs.symlink(at('sys/devices/pci0000:00/0000:01:00.0'), at('sys/class/drm/card0/device'));
        yield* fs.makeDirectory(at('sys/class/drm/card1-DP-1'), { recursive: true });
        const binary = yield* write('llama.cpp/build/bin/llama-server', '#!/bin/sh\n', 0o755);
        yield* write('llama.cpp/build/bin/libggml-cuda.so', '');
        yield* write('llama.cpp/build/bin/libggml-base.so', '');
        yield* write('llama.cpp/build/bin/libother.so', '');
        yield* gitRepo(at('llama.cpp'), 1_700_000_000);
        const model = yield* write('models/m.gguf', 'x');
        yield* write(
          'proc/mounts',
          `/dev/nvme0n1p2 / ext4 rw 0 0\nfs ${at('models')} xfs rw 0 0\nfs ${at('mo')} btrfs rw 0 0\n`,
        );

        const readings = yield* readSys({
          procRoot: proc,
          sysRoot: sys,
          binary,
          modelPath: model,
          logLines: [
            { text: 'system_info: n_threads = 6 | AVX2 = 1 |' },
            { text: 'CUDA error: CUDA driver version is insufficient for CUDA runtime version' },
            { text: 'system_info: n_threads = 12 | AVX2 = 1 |' },
          ],
          busIds: ['0000:01:00.0', '0000:08:00.0'],
        });
        assert.deepStrictEqual(readings.governors, ['performance', 'schedutil', 'powersave']);
        assert.strictEqual(readings.thp, 'madvise');
        assert.strictEqual(readings.memlockLimitBytes, 8 * MiB);
        assert.strictEqual(readings.swappiness, 10);
        assert.strictEqual(readings.cmdline, 'BOOT_IMAGE=/vmlinuz iommu=pt');
        assert.strictEqual(readings.iommuActive, true);
        assert.deepStrictEqual(readings.modules, ['nvidia_uvm', 'nvidia']);
        assert.deepStrictEqual(readings.backendLibs, ['libggml-base.so', 'libggml-cuda.so']);
        assert.strictEqual(readings.driver, '580.95.05');
        assert.strictEqual(readings.cudaDriver, null);
        assert.deepStrictEqual(readings.bar1Bytes, { '0000:01:00.0': 0x08_0000_0000 });
        assert.deepStrictEqual(readings.amdDpm, {
          '0000:08:00.0': {
            level: 'auto',
            path: path.join(sys, 'class/drm/card1/device/power_dpm_force_performance_level'),
          },
        });
        assert.strictEqual(readings.buildDate, 1_700_000_000_000);
        assert.strictEqual(readings.systemInfo, 'system_info: n_threads = 12 | AVX2 = 1 |');
        assert.strictEqual(readings.cudaDriverError, true);
        // The model folder is not a block device of the fake /sys: no rotational reading, the fs type from the mounts.
        assert.deepStrictEqual(readings.modelDisk, { rotational: null, fsType: 'xfs' });
      }),
    ),
  );

  it.effect('readSys tolerates an empty tree, takes the driver from NVML and filters the DPM by bus id', () =>
    fresh(
      Effect.gen(function* () {
        const { fs, at, write } = yield* workspace;
        const empty = yield* readSys({
          procRoot: at('proc'),
          sysRoot: at('sys'),
          binary: at('missing'),
          modelPath: null,
          logLines: NO_LOGS,
        });
        assert.deepStrictEqual(empty, {
          governors: [],
          thp: null,
          memlockLimitBytes: null,
          swappiness: null,
          cmdline: '',
          iommuActive: null,
          modules: [],
          backendLibs: [],
          driver: null,
          cudaDriver: null,
          bar1Bytes: {},
          amdDpm: {},
          amdGfx: {},
          hipTargets: null,
          buildDate: null,
          systemInfo: null,
          cudaDriverError: false,
          modelDisk: null,
        });

        yield* write('proc/self/limits', 'Max locked memory         unlimited            unlimited            bytes\n');
        yield* fs.makeDirectory(at('sys/class/iommu'), { recursive: true });
        yield* write('sys/module/nvidia/version', '570.0\n');
        yield* write('sys/devices/pci0000:00/0000:08:00.0/power_dpm_force_performance_level', 'high\n');
        yield* fs.makeDirectory(at('sys/class/drm/card1'), { recursive: true });
        yield* fs.symlink(at('sys/devices/pci0000:00/0000:08:00.0'), at('sys/class/drm/card1/device'));
        // A binary outside any git checkout: no build date.
        const binary = yield* write('bin/llama-server', '#!/bin/sh\n', 0o755);
        const options = {
          procRoot: at('proc'),
          sysRoot: at('sys'),
          binary,
          modelPath: null,
          logLines: NO_LOGS,
          nvml: { driver: '580.1', cudaDriver: 12080 },
        };
        const all = yield* readSys(options);
        assert.strictEqual(all.memlockLimitBytes, Number.POSITIVE_INFINITY);
        assert.strictEqual(all.iommuActive, false);
        assert.strictEqual(all.driver, '580.1');
        assert.strictEqual(all.cudaDriver, 12080);
        assert.strictEqual(all.buildDate, null);
        assert.deepStrictEqual(Rec.keys(all.amdDpm), ['0000:08:00.0']);
        const other = yield* readSys({ ...options, busIds: ['0000:01:00.0'] });
        assert.deepStrictEqual(other.amdDpm, {});
      }),
    ),
  );

  it('gfxName reads the MMmmss of KFD, minor and stepping in hex; kfdBusId the domain and location', () => {
    assert.deepStrictEqual(Arr.map([120001, 100306, 90010, 110001, 0, -1], gfxName), [
      Option.some('gfx1201'),
      Option.some('gfx1036'),
      Option.some('gfx90a'),
      Option.some('gfx1101'),
      Option.none(),
      Option.none(),
    ]);
    assert.deepStrictEqual(
      [
        kfdBusId({ domain: 0, location: 2048 }),
        kfdBusId({ domain: 0, location: 3328 }),
        kfdBusId({ domain: 1, location: (0xc3 << 8) | (2 << 3) | 1 }),
      ],
      ['0000:08:00.0', '0000:0d:00.0', '0001:c3:02.1'],
    );
  });

  it.effect('readSys reads the gfx of the KFD nodes and the HIP targets beside the binary, kept until a rebuild', () =>
    fresh(
      Effect.gen(function* () {
        const { fs, at, write } = yield* workspace;
        const node = (n: number, gfx: number, location: number) =>
          write(
            `sys/class/kfd/kfd/topology/nodes/${n}/properties`,
            `cpu_cores_count 0\ngfx_target_version ${gfx}\nlocation_id ${location}\ndomain 0\n`,
          );
        yield* node(0, 0, 0);
        yield* node(1, 120001, 2048);
        yield* node(2, 100306, 3328);
        const binary = yield* write('bin/llama-server', '#!/bin/sh\n', 0o755);
        // One target cut in two by the 64 KiB chunks of the stream, another further on; the same twice.
        const marker = '__CLANG_OFFLOAD_BUNDLE__hipv4-amdgcn-amd-amdhsa--gfx1201';
        const lib = at('bin/libggml-hip.so');
        const body = `${Str.repeat(65536 - 40)('x')}${marker}\0${Str.repeat(1000)('y')}hipv4-amdgcn-amd-amdhsa--gfx11-generic\0${marker}`;
        yield* fs.writeFileString(lib, body);
        const memos = yield* Layer.build(TuningMemo.layer);
        const memo = Context.get(memos, TuningMemo);
        const options = { sysRoot: at('sys'), procRoot: at('proc'), binary, modelPath: null, logLines: NO_LOGS };
        const first = yield* readSys({ ...options, hipTargets: memo.hipTargets });
        assert.deepStrictEqual(first.amdGfx, { '0000:08:00.0': 'gfx1201', '0000:0d:00.0': 'gfx1036' });
        assert.deepStrictEqual(first.hipTargets, ['gfx11-generic', 'gfx1201']);
        // Kept by path, mtime and size: the same bytes count without a target, the mtime put back, are not read again;
        // a new mtime (a rebuild) is.
        const blank = Str.repeat(body.length)('z');
        const direct = yield* readHipTargets(lib);
        assert.deepStrictEqual(direct, first.hipTargets);
        // In seconds.
        yield* fs.utimes(lib, 0, 1_000);
        const read = yield* readSys({ ...options, hipTargets: memo.hipTargets });
        assert.deepStrictEqual(read.hipTargets, first.hipTargets);
        yield* fs.writeFileString(lib, blank);
        yield* fs.utimes(lib, 0, 1_000);
        const kept = yield* readSys({ ...options, hipTargets: memo.hipTargets });
        assert.deepStrictEqual(kept.hipTargets, first.hipTargets);
        yield* fs.utimes(lib, 0, 2_000);
        const rebuilt = yield* readSys({ ...options, hipTargets: memo.hipTargets });
        assert.deepStrictEqual(rebuilt.hipTargets, []);
      }),
    ),
  );

  it.effect('resolveBinary: a PATH lookup, a relative path, a symlink, a missing binary', () =>
    fresh(
      Effect.gen(function* () {
        const { fs, path, at, write } = yield* workspace;
        const real = yield* write('real/llama-server', '#!/bin/sh\n', 0o755);
        yield* fs.makeDirectory(at('bin'));
        yield* fs.symlink(real, at('bin/llama-server'));
        const found = yield* resolveBinary('llama-server').pipe(
          Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnv({ env: { PATH: at('bin') } })),
        );
        assert.deepStrictEqual(found, Option.some(real));
        const relative = path.relative(path.resolve('.'), at('bin/llama-server'));
        const fromCwd = yield* resolveBinary(relative);
        assert.deepStrictEqual(fromCwd, Option.some(real));
        const linked = yield* resolveBinary(at('bin/llama-server'));
        assert.deepStrictEqual(linked, Option.some(real));
        const missing = yield* resolveBinary('llama-server').pipe(
          Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnv({ env: { PATH: at('none') } })),
        );
        assert.deepStrictEqual(missing, Option.none());
        const gone = yield* resolveBinary(at('gone/llama-server'));
        assert.deepStrictEqual(gone, Option.none());
      }),
    ),
  );

  it('largestBar keeps the largest of the first six BARs', () => {
    assert.strictEqual(largestBar(null), 0);
    assert.strictEqual(largestBar(''), 0);
    assert.strictEqual(largestBar('0x0 0xff 0x0\nnot a bar\n0x100 0x1ff 0x0'), 256);
    const seventh = Str.repeat(6)('0x0 0x0 0x0\n');
    assert.strictEqual(largestBar(`${seventh}0x0 0xffff 0x0`), 1);
  });

  it('fsTypeOf takes the longest mount point that covers the path', () => {
    const mounts = '/dev/a / ext4 rw 0 0\n/dev/b /data xfs rw 0 0\n/dev/c /data/models btrfs rw 0 0\n';
    assert.strictEqual(fsTypeOf({ mounts, path: '/data/models/m.gguf' }), 'btrfs');
    assert.strictEqual(fsTypeOf({ mounts, path: '/data/modelsX/m.gguf' }), 'xfs');
    assert.strictEqual(fsTypeOf({ mounts, path: '/home/m.gguf' }), 'ext4');
    assert.strictEqual(fsTypeOf({ mounts: null, path: '/m.gguf' }), null);
  });
});
