import { NodeServices } from '@effect/platform-node';
import { assert, layer } from '@effect/vitest';
import { Effect, FileSystem, Option, Path } from 'effect';
import { TestClock } from 'effect/testing';
import { devMajorMinor, makeDiskSampler, physicalDisks, resolveModelDisk } from './disk.ts';
import { makeProcSampler } from './proc.ts';
import { makeSystemSampler } from './system.ts';

const write = (file: string, text: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.makeDirectory(path.dirname(file), { recursive: true });
    yield* fs.writeFileString(file, text);
  });

const tmp = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: 'lw-machine-' });
  return { root, proc: path.join(root, 'proc'), sys: path.join(root, 'sys'), path, fs };
});

const stat = (user: number, idle: number, c0: [number, number], c1: [number, number]) =>
  `cpu  ${user} 0 0 ${idle} 0 0 0 0 0 0\ncpu0 ${c0[0]} 0 0 ${c0[1]} 0 0 0 0 0 0\ncpu1 ${c1[0]} 0 0 ${c1[1]} 0 0 0 0 0 0\nintr 1\n`;

const diskstats = (reads: number, writes: number, other = 0) =>
  `   8       0 sda 1 0 ${reads} 0 1 0 ${writes} 0 0 0 0\n 259 0 nvme0n1 1 0 ${other} 0 1 0 ${other} 0 0 0 0\n   7 0 loop0 1 0 99 0 1 0 99 0 0 0 0\n`;

layer(NodeServices.layer)('machine samplers', (it) => {
  it.effect('the system sampler gives total and per-core CPU from two reads of /proc/stat', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { proc, sys, path } = yield* tmp;
        const system = yield* makeSystemSampler({ procRoot: proc, sysRoot: sys });
        yield* write(path.join(proc, 'stat'), stat(100, 900, [50, 450], [50, 450]));
        const first = yield* system.sample;
        assert.strictEqual(first.cpuPct, 0);
        assert.deepStrictEqual(first.corePct, [0, 0]);
        yield* write(path.join(proc, 'stat'), stat(200, 1600, [190, 500], [60, 1200]));
        const second = yield* system.sample;
        assert.closeTo(second.cpuPct, 12.5, 1e-9);
        assert.closeTo(second.corePct[0] ?? -1, (100 * 140) / 190, 1e-9);
        assert.closeTo(second.corePct[1] ?? -1, (100 * 10) / 760, 1e-9);
      }),
    ),
  );

  it.effect('the system sampler reads meminfo, loadavg, the mean scaling_cur_freq and the first k10temp sensor', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { proc, sys, path } = yield* tmp;
        yield* write(path.join(proc, 'stat'), stat(1, 9, [1, 4], [0, 5]));
        yield* write(
          path.join(proc, 'meminfo'),
          'MemTotal: 1000 kB\nMemFree: 100 kB\nMemAvailable: 400 kB\nCached: 200 kB\nSwapTotal: 50 kB\nSwapFree: 20 kB\n',
        );
        yield* write(path.join(proc, 'loadavg'), '0.50 1.25 2.00 1/100 5\n');
        yield* write(path.join(sys, 'devices/system/cpu/cpu0/cpufreq/scaling_cur_freq'), '3000000\n');
        yield* write(path.join(sys, 'devices/system/cpu/cpu1/cpufreq/scaling_cur_freq'), '4000000\n');
        yield* write(path.join(sys, 'class/hwmon/hwmon1/name'), 'nvme\n');
        yield* write(path.join(sys, 'class/hwmon/hwmon1/temp1_input'), '99000\n');
        yield* write(path.join(sys, 'class/hwmon/hwmon2/name'), 'k10temp\n');
        yield* write(path.join(sys, 'class/hwmon/hwmon2/temp1_input'), '47500\n');
        const system = yield* makeSystemSampler({ procRoot: proc, sysRoot: sys });
        const s = yield* system.sample;
        assert.deepStrictEqual(s.mem, {
          totalBytes: 1024000,
          availableBytes: 409600,
          cachedBytes: 204800,
          swapTotalBytes: 51200,
          swapUsedBytes: 30720,
        });
        assert.deepStrictEqual(s.load, [0.5, 1.25, 2]);
        assert.strictEqual(s.freqMhz, 3500);
        assert.strictEqual(s.tempC, 47.5);
      }),
    ),
  );

  it.effect('an unreadable file is a null field, not a failure', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { proc, sys, path } = yield* tmp;
        yield* write(path.join(proc, 'stat'), stat(1, 9, [1, 4], [0, 5]));
        yield* write(path.join(proc, 'loadavg'), '0.50 1.25 2.00 1/100 5\n');
        const system = yield* makeSystemSampler({ procRoot: proc, sysRoot: sys });
        const s = yield* system.sample;
        assert.isNull(s.mem);
        assert.isNull(s.tempC);
        assert.isNull(s.freqMhz);
        assert.deepStrictEqual(s.load, [0.5, 1.25, 2]);
        assert.strictEqual(s.corePct.length, 2);
      }),
    ),
  );

  it.effect(
    'the disk sampler gives read and write rates per disk, their sum and the model disk, 0 on the first sample',
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { proc, path } = yield* tmp;
          const file = path.join(proc, 'diskstats');
          const sampler = yield* makeDiskSampler({ disks: ['sda', 'nvme0n1'], procRoot: proc });
          yield* write(file, diskstats(1000, 2000, 100));
          const first = yield* sampler.sample('nvme0n1');
          assert.strictEqual(first.readBps, 0);
          assert.strictEqual(first.writeBps, 0);
          assert.deepStrictEqual(first.model, { disk: 'nvme0n1', readBps: 0 });
          yield* TestClock.adjust('1 second');
          yield* write(file, diskstats(1000 + 2, 2000 + 4, 100 + 8));
          const second = yield* sampler.sample('nvme0n1');
          assert.deepStrictEqual(second.perDisk.sda, { readBps: 1024, writeBps: 2048 });
          assert.deepStrictEqual(second.perDisk.nvme0n1, { readBps: 4096, writeBps: 4096 });
          assert.strictEqual(second.readBps, 1024 + 4096);
          assert.strictEqual(second.writeBps, 2048 + 4096);
          assert.deepStrictEqual(second.model, { disk: 'nvme0n1', readBps: 4096 });
          const none = yield* sampler.sample(null);
          assert.isNull(none.model);
          assert.strictEqual(none.readBps, 0);
        }),
      ),
  );

  it.effect('physicalDisks lists /sys/block without loop, ram and zram, and only entries with a device', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { sys, path, fs } = yield* tmp;
        const block = path.join(sys, 'block');
        for (const name of ['sdb', 'nvme0n1', 'loop0', 'ram0', 'zram0', 'dm-0']) {
          yield* fs.makeDirectory(path.join(block, name), { recursive: true });
        }
        for (const name of ['sdb', 'nvme0n1', 'loop0', 'zram0']) {
          yield* fs.makeDirectory(path.join(block, name, 'device'), { recursive: true });
        }
        const listed = yield* physicalDisks(block);
        assert.deepStrictEqual(listed, ['nvme0n1', 'sdb']);
        const absent = yield* physicalDisks(path.join(sys, 'absent'));
        assert.deepStrictEqual(absent, []);
      }),
    ),
  );

  it.effect('resolveModelDisk resolves a partition to its disk', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { root, sys, path, fs } = yield* tmp;
        const model = path.join(root, 'model.gguf');
        yield* write(model, 'GGUF');
        const [major, minor] = devMajorMinor((yield* fs.stat(model)).dev);
        const disk = path.join(sys, 'devices/pci0000:00/nvme/nvme0n1');
        yield* fs.makeDirectory(path.join(disk, 'nvme0n1p2'), { recursive: true });
        yield* write(path.join(disk, 'nvme0n1p2', 'partition'), '2\n');
        yield* fs.makeDirectory(path.join(sys, 'dev/block'), { recursive: true });
        yield* fs.symlink(path.join(disk, 'nvme0n1p2'), path.join(sys, 'dev/block', `${major}:${minor}`));
        const viaPartition = yield* resolveModelDisk(model, { sysRoot: sys });
        assert.deepStrictEqual(viaPartition, Option.some('nvme0n1'));
        yield* fs.remove(path.join(sys, 'dev/block', `${major}:${minor}`));
        yield* fs.symlink(disk, path.join(sys, 'dev/block', `${major}:${minor}`));
        const viaDisk = yield* resolveModelDisk(model, { sysRoot: sys });
        assert.deepStrictEqual(viaDisk, Option.some('nvme0n1'));
        const missing = yield* resolveModelDisk(path.join(root, 'missing'), { sysRoot: sys });
        assert.isTrue(Option.isNone(missing));
      }),
    ),
  );

  it.effect(
    'the process sampler gives CPU % from utime+stime and RSS from VmRSS, and none for a pid that is gone',
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { proc, path } = yield* tmp;
          const stat = (ticks: number) =>
            `42 (llama server) S 1 1 1 0 -1 0 0 0 0 0 ${ticks} ${ticks} 0 0 20 0 1 0 1 0 0\n`;
          const dir = path.join(proc, '42');
          yield* write(path.join(dir, 'status'), 'Name:\tllama\nVmRSS:\t   2048 kB\n');
          yield* write(path.join(dir, 'stat'), stat(100));
          const sampler = yield* makeProcSampler({ procRoot: proc });
          const first = yield* sampler.sample(42);
          assert.deepStrictEqual(first, Option.some({ cpuPct: 0, rssBytes: 2048 * 1024 }));
          yield* TestClock.adjust('2 seconds');
          yield* write(path.join(dir, 'stat'), stat(150));
          const second = yield* sampler.sample(42);
          // 100 more ticks in 2 s of 100 ticks/s: one core at 50 %.
          assert.deepStrictEqual(second, Option.some({ cpuPct: 50, rssBytes: 2048 * 1024 }));
          const gone = yield* sampler.sample(43);
          assert.isTrue(Option.isNone(gone));
        }),
      ),
  );
});
