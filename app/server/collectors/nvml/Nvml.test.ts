import { NodeServices } from '@effect/platform-node';
import { assert, describe, it, layer } from '@effect/vitest';
import type { GpuReading } from '@llama-webui/shared';
import {
  Array as Arr,
  Duration,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Option,
  Path,
  Predicate,
  Schedule,
  Schema,
  Scope,
  String as Str,
  Stream,
} from 'effect';
import { ChildProcess, ChildProcessSpawner } from 'effect/process';
import { isAlive } from '../../llama/procScan.ts';
import { CLOSE_BOUND } from '../../process/followed.ts';
import { stuckRelease } from '../../testing/stuckRelease.ts';
import { MEASURE_ALL, procVramOf } from '../gpu.ts';
import { isFresh, type NvmlState, onConfigure, onSample, startNvml, workerPath } from './Nvml.ts';
import { type NvmlSnapshot, ToSampler } from './protocol.ts';

const GiB = 1024 ** 3;
const MiB = 1024 ** 2;

const GPU_A: GpuReading = {
  key: 'nvidia:GPU-a',
  vendor: 'nvidia',
  name: 'RTX',
  busId: '0000:01:00.0',
  utilPct: 10,
  vramUsedBytes: 6 * GiB,
  vramTotalBytes: 16 * GiB,
  tempC: 40,
  powerW: 50,
};

const snapshot = (procs: NvmlSnapshot['procs'] = []): NvmlSnapshot => ({
  gpus: [GPU_A],
  procs,
  system: { driver: null, cudaDriver: null },
});

const started = (intervalMs: number): NvmlState => ({
  gpus: [],
  procs: [],
  system: null,
  lastSampleAt: 0,
  intervalMs,
  freshIntervalMs: intervalMs,
  dead: false,
});

describe('the NVML state', () => {
  it('lowering the interval keeps the last sample fresh until the worker samples at the new pace', () => {
    const configured = onConfigure(onSample(started(2000), snapshot(), 0), 250);
    // The worker's pending round, scheduled at the old pace, has not run yet.
    assert.isTrue(isFresh(configured, 3 * 2000));
    const resampled = onSample(configured, snapshot(), 1500);
    // The new pace: 3 × 250 ms without a sample is stale.
    assert.isTrue(isFresh(resampled, 1500 + 750));
    assert.isFalse(isFresh(resampled, 1500 + 1000));
  });

  it("a process VRAM NVML cannot report counts the card's VRAM in use", () => {
    const state = onSample(
      started(1000),
      snapshot([
        { pid: 7, key: GPU_A.key, usedBytes: 512 * MiB },
        { pid: 7, key: GPU_A.key, usedBytes: 256 * MiB },
        { pid: 8, key: GPU_A.key, usedBytes: null },
        { pid: 8, key: 'nvidia:GPU-gone', usedBytes: null },
      ]),
      0,
    );
    assert.deepStrictEqual([...procVramOf(state, 7)], [[GPU_A.key, 768 * MiB]]);
    assert.deepStrictEqual(
      [...procVramOf(state, 8)],
      [
        [GPU_A.key, 6 * GiB],
        ['nvidia:GPU-gone', 0],
      ],
    );
    assert.strictEqual(procVramOf(state, 9).size, 0);
  });
});

/** The fake sampler (`testing/fixtures/fakeNvml.ts`): `node fakeNvml.ts <behaviour> <dir>`. */
const FAKE = Effect.gen(function* () {
  const path = yield* Path.Path;
  return path.resolve(import.meta.dirname, '../../testing/fixtures/fakeNvml.ts');
});

/** A folder of the test's own, where the fake records its pid and what it receives; removed with the scope. */
const workspace = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const fake = yield* FAKE;
  const dir = yield* fs.makeTempDirectoryScoped({ prefix: 'lw-nvml-' });
  const lines = (name: string) =>
    Effect.gen(function* () {
      const file = path.join(dir, name);
      if (!(yield* fs.exists(file))) return [];
      const text = yield* fs.readFileString(file);
      return Arr.filter(Str.split(text, '\n'), Str.isNonEmpty);
    }).pipe(Effect.orDie);
  const command = (behaviour: string) => ({ cmd: process.execPath, args: [fake, behaviour, dir] });
  /** The real sampler, its pid recorded as the fake's (`exec` keeps it). */
  const realWorker = {
    cmd: '/bin/sh',
    args: [
      '-c',
      'echo $$ >> "$1/pids"; exec "$2" --disable-warning=ExperimentalWarning "$3"',
      'sh',
      dir,
      process.execPath,
      workerPath(import.meta.url),
    ],
  };
  const pids = lines('pids').pipe(Effect.map(Arr.map(Number)));
  const received = lines('received');
  /** Every sampler the test started is gone. */
  const assertAllDead = Effect.gen(function* () {
    const all = yield* pids;
    const alive = yield* Effect.filter(all, isAlive);
    assert.deepStrictEqual(alive, []);
  });
  return { dir, command, realWorker, pids, received, assertAllDead };
});

type Workspace = Effect.Success<typeof workspace>;
type Services = FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner;

/** `test` in a workspace; once the reader's scope is closed, every sampler it started must be dead. */
const withFakes = <A, E>(
  test: (ws: Workspace) => Effect.Effect<A, E, Services | Scope.Scope>,
): Effect.Effect<void, E | Error, Services> =>
  Effect.scoped(
    Effect.gen(function* () {
      const ws = yield* workspace;
      yield* Effect.scoped(test(ws));
      yield* ws.assertAllDead;
    }),
  );

/** `effect` again every 20 ms until `ok` holds, 3 s at most. */
const eventually = <A, E, R>(effect: Effect.Effect<A, E, R>, ok: (a: A) => boolean) =>
  effect.pipe(Effect.repeat({ until: ok, schedule: Schedule.spaced('20 millis') }), Effect.timeout('3 seconds'));

const decodeCommand = Schema.decodeUnknownEffect(Schema.fromJsonString(ToSampler));
const encodeCommand = Schema.encodeEffect(Schema.fromJsonString(ToSampler));

/** Where the system keeps `libnvidia-ml.so.1`: `/usr/lib*` or one of its arch folders (`x86_64-linux-gnu`). */
const nvmlLibrary = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const usr = yield* fs.readDirectory('/usr');
  const libs = Arr.filter(usr, Str.startsWith('lib'));
  const dirs = yield* Effect.forEach(libs, (lib) =>
    fs.readDirectory(path.join('/usr', lib)).pipe(
      Effect.map((entries) => [
        path.join('/usr', lib),
        ...Arr.map(Arr.filter(entries, Str.endsWith('-linux-gnu')), (e) => path.join('/usr', lib, e)),
      ]),
      Effect.orElseSucceed((): ReadonlyArray<string> => []),
    ),
  );
  return yield* Effect.findFirst(Arr.flatten(dirs), (dir) => fs.exists(path.join(dir, 'libnvidia-ml.so.1')));
}).pipe(Effect.orElseSucceed(() => Option.none<string>()));

const nvmlHere = Option.isSome(await Effect.runPromise(nvmlLibrary.pipe(Effect.provide(NodeServices.layer))));

layer(NodeServices.layer, { excludeTestServices: true })('the NVML reader', (it) => {
  it.effect('workerPath: worker.ts next to the module in development, nvml-worker.mjs next to the bundle', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      assert.strictEqual(workerPath('file:///x/server/collectors/nvml/Nvml.ts'), '/x/server/collectors/nvml/worker.ts');
      assert.strictEqual(workerPath('file:///x/dist/server/index.mjs'), '/x/dist/server/nvml-worker.mjs');
      const here = workerPath(import.meta.url);
      assert.strictEqual(here, path.join(import.meta.dirname, 'worker.ts'));
      const exists = yield* fs.exists(here);
      assert.isTrue(exists);
    }),
  );

  it.effect('a sampler that answers ready gives its readings', () =>
    withFakes((ws) =>
      Effect.gen(function* () {
        const found = yield* startNvml({
          intervalMs: 100,
          needs: MEASURE_ALL,
          lib: Option.some('/x/libnvidia-ml.so.1'),
          command: ws.command('ready-then-sample'),
        });
        const nvml = Option.getOrThrow(found);
        const gpus = yield* eventually(nvml.gpus, (g) => g.length === 1);
        assert.strictEqual(gpus[0]?.key, 'nvidia:GPU-fake');
        const known = yield* nvml.procVram(4242);
        assert.deepStrictEqual([...known], [['nvidia:GPU-fake', 512 * MiB]]);
        const unknown = yield* nvml.procVram(4343);
        assert.deepStrictEqual([...unknown], [['nvidia:GPU-fake', 6 * GiB]]);
        const system = yield* nvml.system;
        assert.deepStrictEqual(system, { driver: '580.95.05', cudaDriver: 13000 });
        yield* nvml.refreshApps;
        yield* nvml.configure({ intervalMs: 500, needs: { pcie: false, skipGpus: ['0000:02:00.0'] } });
        const received = yield* eventually(ws.received, (r) => r.length === 2);
        const commands = yield* Effect.forEach(received, (line) => decodeCommand(line));
        assert.deepStrictEqual(commands, [
          { type: 'start', intervalMs: 100, needs: MEASURE_ALL, lib: '/x/libnvidia-ml.so.1' },
          { type: 'configure', intervalMs: 500, needs: { pcie: false, skipGpus: ['0000:02:00.0'] } },
        ]);
      }),
    ),
  );

  it.effect('stale readings give no GPU and no process VRAM', () =>
    withFakes((ws) =>
      Effect.gen(function* () {
        const found = yield* startNvml({
          intervalMs: 100,
          needs: MEASURE_ALL,
          lib: Option.none(),
          command: ws.command('sample-once'),
        });
        const nvml = Option.getOrThrow(found);
        yield* eventually(nvml.procVram(4242), (m) => m.size === 1);
        // One sample, then nothing for longer than 3 × 100 ms.
        const gpus = yield* eventually(nvml.gpus, (g) => g.length === 0);
        assert.deepStrictEqual(gpus, []);
        const vram = yield* nvml.procVram(4242);
        assert.strictEqual(vram.size, 0);
      }),
    ),
  );

  it.effect('a sampler that never answers is given up after the ready timeout and killed', () =>
    withFakes((ws) =>
      Effect.gen(function* () {
        const [elapsed, found] = yield* startNvml({
          intervalMs: 1000,
          needs: MEASURE_ALL,
          lib: Option.none(),
          command: ws.command('silent'),
          readyTimeout: '300 millis',
        }).pipe(Effect.timed);
        assert.isTrue(Option.isNone(found));
        assert.isAtLeast(Duration.toMillis(elapsed), 300);
        assert.isBelow(Duration.toMillis(elapsed), 2000);
        // Killed before the answer: the fake stays up on its own.
        const pids = yield* ws.pids;
        assert.strictEqual(pids.length, 1);
        const alive = yield* isAlive(pids[0] ?? 0);
        assert.isFalse(alive);
      }),
    ),
  );

  it.effect(
    'a sampler killed but stuck in the kernel is given up after the ready timeout and the bound of its close',
    () =>
      withFakes((ws) =>
        Effect.gen(function* () {
          const stuck = yield* stuckRelease;
          const [elapsed, found] = yield* startNvml({
            intervalMs: 1000,
            needs: MEASURE_ALL,
            lib: Option.none(),
            command: ws.command('silent'),
            readyTimeout: '300 millis',
          }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, stuck.spawner), Effect.timed);
          // None, for the nvidia-smi fallback: the close of the sampler that never came back does not hold the start.
          assert.isTrue(Option.isNone(found));
          assert.isBelow(Duration.toMillis(elapsed), 300 + Duration.toMillis(CLOSE_BOUND) + 700);
          const pids = yield* ws.pids;
          assert.strictEqual(pids.length, 1);
          const alive = yield* isAlive(pids[0] ?? 0);
          assert.isFalse(alive);
          yield* stuck.unstick;
        }),
      ),
  );

  it.effect('the end of the scope of a sampler killed but stuck in the kernel returns within the bound', () =>
    withFakes((ws) =>
      Effect.gen(function* () {
        const stuck = yield* stuckRelease;
        const scope = yield* Scope.make();
        const found = yield* startNvml({
          intervalMs: 100,
          needs: MEASURE_ALL,
          lib: Option.none(),
          command: ws.command('ready-then-sample'),
        }).pipe(Scope.provide(scope), Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, stuck.spawner));
        assert.isTrue(Option.isSome(found));
        const [elapsed] = yield* Effect.timed(Scope.close(scope, Exit.void));
        assert.isBelow(Duration.toMillis(elapsed), Duration.toMillis(CLOSE_BOUND) + 500);
        yield* stuck.unstick;
      }),
    ),
  );

  it.effect('a sampler that errors gives none', () =>
    withFakes((ws) =>
      Effect.gen(function* () {
        const [elapsed, found] = yield* startNvml({
          intervalMs: 1000,
          needs: MEASURE_ALL,
          lib: Option.none(),
          command: ws.command('error'),
        }).pipe(Effect.timed);
        assert.isTrue(Option.isNone(found));
        // The `error` message, not the 3 s ready timeout.
        assert.isBelow(Duration.toMillis(elapsed), 2000);
      }),
    ),
  );

  it.effect('a sampler that exits after ready clears its readings for good', () =>
    withFakes((ws) =>
      Effect.gen(function* () {
        const found = yield* startNvml({
          // Fresh for a minute: only the exit clears the readings.
          intervalMs: 60_000,
          needs: MEASURE_ALL,
          lib: Option.none(),
          command: ws.command('exit-after-ready'),
        });
        const nvml = Option.getOrThrow(found);
        yield* eventually(nvml.gpus, (g) => g.length === 1);
        yield* eventually(nvml.gpus, (g) => g.length === 0);
        yield* nvml.configure({ intervalMs: 1000, needs: MEASURE_ALL });
        yield* Effect.sleep('100 millis');
        const gpus = yield* nvml.gpus;
        assert.deepStrictEqual(gpus, []);
        const vram = yield* nvml.procVram(4242);
        assert.strictEqual(vram.size, 0);
        // No restart.
        const pids = yield* ws.pids;
        assert.strictEqual(pids.length, 1);
      }),
    ),
  );

  it.effect('a sampler exits when its stdin ends', () =>
    withFakes((ws) =>
      Effect.gen(function* () {
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const start = yield* encodeCommand({
          type: 'start',
          intervalMs: 100,
          needs: MEASURE_ALL,
          lib: '/no/such/libnvidia-ml.so',
        });
        const fake = ws.command('ready-then-sample');
        const real = {
          cmd: process.execPath,
          args: ['--disable-warning=ExperimentalWarning', workerPath(import.meta.url)],
        };
        for (const { cmd, args } of [fake, real]) {
          const code = yield* Effect.scoped(
            Effect.gen(function* () {
              const handle = yield* spawner.spawn(
                ChildProcess.make(cmd, args, {
                  stdin: { stream: Stream.encodeText(Stream.make(`${start}\n`)) },
                  stdout: 'pipe',
                  stderr: 'inherit',
                  killSignal: 'SIGKILL',
                }),
              );
              const [, exit] = yield* Effect.all([Stream.runDrain(handle.stdout), handle.exitCode], {
                concurrency: 2,
              });
              return exit;
            }),
          ).pipe(Effect.timeout('5 seconds'));
          assert.strictEqual(code, 0);
        }
      }),
    ),
  );

  it.effect('a real worker with a missing NVML library resolves null (the nvidia-smi fallback)', () =>
    withFakes((ws) =>
      Effect.gen(function* () {
        const [elapsed, found] = yield* startNvml({
          intervalMs: 1000,
          needs: MEASURE_ALL,
          lib: Option.some('/no/such/libnvidia-ml.so'),
          command: ws.realWorker,
        }).pipe(Effect.timed);
        assert.isTrue(Option.isNone(found));
        // The worker's `error` message, not the 3 s ready timeout.
        assert.isBelow(Duration.toMillis(elapsed), 2000);
        const pids = yield* ws.pids;
        assert.strictEqual(pids.length, 1);
      }),
    ),
  );

  it.effect.skipIf(!nvmlHere)('a real worker reads NVML when the library is here', () =>
    withFakes((ws) =>
      Effect.gen(function* () {
        const found = yield* startNvml({
          intervalMs: 200,
          needs: MEASURE_ALL,
          lib: Option.none(),
          command: ws.realWorker,
        });
        const nvml = Option.getOrThrow(found);
        const gpus = yield* eventually(nvml.gpus, (g) => g.length > 0);
        for (const g of gpus) {
          assert.match(g.key, /^nvidia:GPU-/);
          assert.match(g.busId, /^[0-9a-f]{4}:[0-9a-f]{2}:[0-9a-f]{2}\.[0-9a-f]$/);
        }
        const system = yield* nvml.system;
        assert.isTrue(Predicate.isString(system?.driver));
      }),
    ),
  );

  it.effect('a sampler that writes a line that is not a message before ready gives none at once', () =>
    withFakes((ws) =>
      Effect.gen(function* () {
        const [elapsed, found] = yield* startNvml({
          intervalMs: 1000,
          needs: MEASURE_ALL,
          lib: Option.none(),
          command: ws.command('garbage-before-ready'),
        }).pipe(Effect.timed);
        assert.isTrue(Option.isNone(found));
        // Not the 3 s ready timeout.
        assert.isBelow(Duration.toMillis(elapsed), 2000);
      }),
    ),
  );

  it.effect('a sampler that writes a line that is not a message is dead for good, and killed', () =>
    withFakes((ws) =>
      Effect.gen(function* () {
        const found = yield* startNvml({
          // Fresh for a minute: only the death clears the readings.
          intervalMs: 60_000,
          needs: MEASURE_ALL,
          lib: Option.none(),
          command: ws.command('garbage-after-ready'),
        });
        const nvml = Option.getOrThrow(found);
        yield* eventually(nvml.gpus, (g) => g.length === 1);
        yield* eventually(nvml.gpus, (g) => g.length === 0);
        // Killed while the reader's scope is still open: the fake stays up on its own.
        const pids = yield* ws.pids;
        const alive = yield* eventually(isAlive(pids[0] ?? 0), (a) => !a);
        assert.isFalse(alive);
        // A configure after the death reaches nothing and changes nothing.
        yield* nvml.configure({ intervalMs: 1000, needs: MEASURE_ALL });
        const gpus = yield* nvml.gpus;
        assert.deepStrictEqual(gpus, []);
      }),
    ),
  );

  it.effect('a sampler stuck in a native call does not hold the process when it exits', () =>
    withFakes((ws) =>
      Effect.gen(function* () {
        const scope = yield* Scope.make();
        const found = yield* startNvml({
          intervalMs: 1000,
          needs: MEASURE_ALL,
          lib: Option.none(),
          command: ws.command('busy'),
        }).pipe(Scope.provide(scope));
        assert.isTrue(Option.isSome(found));
        // In its loop by now.
        yield* Effect.sleep('200 millis');
        // The close runs in a fiber of its own: a sampler it cannot end fails the test instead of holding it.
        const closing = yield* Effect.forkDetach(Scope.close(scope, Exit.void));
        const [elapsed, closed] = yield* Fiber.await(closing).pipe(Effect.timeoutOption('2 seconds'), Effect.timed);
        assert.isTrue(Option.isSome(closed));
        assert.isBelow(Duration.toMillis(elapsed), 500);
      }),
    ),
  );
});
