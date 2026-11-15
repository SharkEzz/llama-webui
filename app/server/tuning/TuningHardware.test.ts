import { NodeServices } from '@effect/platform-node';
import { assert, describe, it } from '@effect/vitest';
import type { GpuSample, Snapshot } from '@llama-webui/shared';
import { Array as Arr, ConfigProvider, Effect, FileSystem, Layer, Path, type Scope } from 'effect';
import { BenchHardware } from '../bench/BenchHardware.ts';
import * as Db from '../db/Db.ts';
import { Monitor } from '../monitor/Monitor.ts';
import { SettingsRepo } from '../settings/SettingsRepo.ts';
import { TuningHardware } from './TuningHardware.ts';

const MiB = 1024 ** 2;
const GiB = 1024 ** 3;

const GPU: GpuSample = {
  key: 'nvidia:a',
  vendor: 'nvidia',
  name: 'NVIDIA GeForce RTX 5070 Ti',
  busId: '0000:01:00.0',
  utilPct: 0,
  vramUsedBytes: 4 * GiB,
  vramTotalBytes: 15933 * MiB,
  tempC: null,
  powerW: null,
  procVramBytes: GiB,
};

/** A snapshot with the RAM and the GPUs a tick would give, nothing else. */
const SNAPSHOT: Snapshot = {
  at: 0,
  tick: 1,
  health: null,
  rates: { genTps: 0, ppTps: 0 },
  slots: null,
  kv: null,
  queue: null,
  lastRequest: null,
  spec: null,
  recentRequests: [],
  gpus: [],
  allGpus: [GPU],
  proc: null,
  system: {
    cpuPct: 0,
    corePct: [],
    freqMhz: null,
    tempC: null,
    load: null,
    mem: { totalBytes: 64 * GiB, availableBytes: 40 * GiB, cachedBytes: 0, swapTotalBytes: 0, swapUsedBytes: 0 },
  },
  disk: null,
  points: {},
  history: { intervalMs: 1000, capacity: 0 },
};

/** The stub monitor, with `snapshot` as its last tick. */
const monitorAt = (snapshot: Snapshot | null) =>
  Layer.effect(
    Monitor,
    Effect.map(Monitor, (stub) => Monitor.of({ ...stub, latest: Effect.succeed(snapshot) })),
  ).pipe(Layer.provide(Monitor.layerStub));

/** The tuning hardware on `/proc` at `procRoot`, a new database and new caches, the monitor at `snapshot`. */
const layerAt = (options: { readonly procRoot: string; readonly snapshot: Snapshot | null }) =>
  TuningHardware.layerWith({ procRoot: options.procRoot, sysRoot: options.procRoot }).pipe(
    Layer.provideMerge(Layer.mergeAll(BenchHardware.layer, monitorAt(options.snapshot))),
    Layer.provideMerge(SettingsRepo.layer),
    Layer.provideMerge(Db.layerAt(':memory:')),
    Layer.provideMerge(NodeServices.layer),
  );

/** A HOME of the test's own, with `bin/llama-bench` printing `body` and `proc/meminfo` when given. */
const workspace = Effect.fn('workspace')(function* (options: { readonly bench: string; readonly meminfo?: string }) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* fs.makeTempDirectoryScoped({ prefix: 'lw-tuning-hw-' });
  yield* fs.makeDirectory(path.join(home, 'bin'));
  yield* fs.makeDirectory(path.join(home, 'proc'));
  const bench = path.join(home, 'bin/llama-bench');
  yield* fs.writeFileString(bench, `#!/bin/sh\n${options.bench}\n`);
  yield* fs.chmod(bench, 0o755);
  if (options.meminfo !== undefined) yield* fs.writeFileString(path.join(home, 'proc/meminfo'), options.meminfo);
  return { home, procRoot: path.join(home, 'proc') };
});

/** The hardware read with the `binary` setting `~/bin/llama-server` and HOME at `home`. */
const readAt = Effect.fn('readAt')(function* (options: {
  readonly home: string;
  readonly procRoot: string;
  readonly snapshot: Snapshot | null;
}) {
  const context = yield* Layer.build(layerAt(options));
  const read = Effect.gen(function* () {
    const settings = yield* SettingsRepo;
    yield* settings.patch({ binary: '~/bin/llama-server' });
    const hardware = yield* TuningHardware;
    return yield* hardware.read;
  });
  return yield* read.pipe(
    Effect.provideContext(context),
    Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnv({ env: { HOME: options.home } })),
  );
});

/** `test` on the Node platform, in a scope closed at its end (its folders removed). */
const inPlatform = <A, E>(test: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | Scope.Scope>) =>
  Layer.build(NodeServices.layer).pipe(
    Effect.flatMap((context) => Effect.provideContext(test, context)),
    Effect.scoped,
  );

const LIST = "printf 'Available devices:\\n  CUDA0: NVIDIA GeForce RTX 5070 Ti (15933 MiB, 15643 MiB free)\\n'";

describe('TuningHardware', () => {
  it.effect('the tuning hardware lists the devices of a ~/… binary, the RAM of /proc/meminfo without a snapshot', () =>
    inPlatform(
      Effect.gen(function* () {
        const { home, procRoot } = yield* workspace({
          bench: LIST,
          meminfo: 'MemTotal:       65536000 kB\nMemFree:         1000000 kB\nMemAvailable:   32768000 kB\n',
        });
        const hardware = yield* readAt({ home, procRoot, snapshot: null });
        assert.deepStrictEqual(
          Arr.map(hardware.devices, (d) => [d.id, d.freeMib]),
          [['CUDA0', 15643]],
        );
        assert.strictEqual(hardware.devicesError, null);
        assert.strictEqual(hardware.ramTotalBytes, 65536000 * 1024);
        assert.strictEqual(hardware.ramAvailableBytes, 32768000 * 1024);
        // The fake /proc has no cpuinfo: the CPU's defaults.
        assert.strictEqual(hardware.cpu.logicalThreads, 1);
      }),
    ),
  );

  it.effect('the RAM and the live memory of the GPUs come from the snapshot', () =>
    inPlatform(
      Effect.gen(function* () {
        const { home, procRoot } = yield* workspace({ bench: LIST });
        const hardware = yield* readAt({ home, procRoot, snapshot: SNAPSHOT });
        assert.strictEqual(hardware.ramTotalBytes, 64 * GiB);
        assert.strictEqual(hardware.ramAvailableBytes, 40 * GiB);
        // 15933 MiB, 4 GiB used of which 1 GiB is llama-server's.
        assert.deepStrictEqual(
          Arr.map(hardware.devices, (d) => [d.freeMib, d.otherUsedMib]),
          [[15933 - 4096, 3072]],
        );
      }),
    ),
  );

  it.effect('a failed listing gives its reason, and no RAM without a snapshot or /proc/meminfo', () =>
    inPlatform(
      Effect.gen(function* () {
        const { home, procRoot } = yield* workspace({ bench: 'exit 134' });
        const hardware = yield* readAt({ home, procRoot, snapshot: null });
        assert.deepStrictEqual(hardware.devices, []);
        assert.include(hardware.devicesError, 'code 134');
        assert.strictEqual(hardware.ramTotalBytes, 0);
        assert.strictEqual(hardware.ramAvailableBytes, 0);
      }),
    ),
  );
});
