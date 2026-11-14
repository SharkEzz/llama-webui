import { NodeServices } from '@effect/platform-node';
import { assert, layer } from '@effect/vitest';
import {
  Array as Arr,
  ConfigProvider,
  Context,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Schedule,
  type Scope,
  String as Str,
} from 'effect';
import type { ChildProcessSpawner } from 'effect/process';
import * as Db from '../db/Db.ts';
import { PciIds } from '../hardware/PciIds.ts';
import { isAlive } from '../llama/procScan.ts';
import { SettingsRepo } from '../settings/SettingsRepo.ts';
import { type CollectorSettings, Collectors } from './Collectors.ts';

const LINE =
  '0, GPU-c7eed07b-43d3-7fe3-0db0-0e51acaf7d28, NVIDIA GeForce RTX 5070 Ti, 0, 5895, 16303, 38, 49.86, 00000000:01:00.0';

/** No such file: the library, nvidia-smi or perf is missing. */
const MISSING = '/nonexistent/llama-webui-test';

/** One start of a fake program: the program, its pid and its arguments. */
interface Call {
  readonly name: string;
  readonly pid: number;
  readonly args: ReadonlyArray<string>;
}

/**
 * A folder of the test's own, removed with the scope. `script` writes an executable shell script that records each of
 * its starts (`<name> <pid> <args>`) in `calls`, then runs `body`; `$DIR` is the folder.
 */
const workspace = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = yield* fs.makeTempDirectoryScoped({ prefix: 'lw-collectors-' });
  const file = (name: string) => path.join(dir, name);
  const script = Effect.fn('script')(function* (name: string, body: string) {
    yield* fs.writeFileString(file(name), `#!/bin/sh\nDIR='${dir}'\necho "${name} $$ $*" >> "$DIR/calls"\n${body}\n`);
    yield* fs.chmod(file(name), 0o755);
    return file(name);
  });
  const calls = Effect.gen(function* () {
    if (!(yield* fs.exists(file('calls')))) return Arr.empty<Call>();
    const text = yield* fs.readFileString(file('calls'));
    return Arr.map(Str.split(Str.trim(text), '\n'), (line): Call => {
      const [name = '', pid = '', ...args] = Str.split(line, ' ');
      return { name, pid: Number(pid), args };
    });
  }).pipe(Effect.orDie);
  /** The starts of `name` whose arguments include `arg`. */
  const callsOf = (name: string, arg?: string) =>
    calls.pipe(Effect.map(Arr.filter((c) => c.name === name && (arg === undefined || c.args.includes(arg)))));
  /** Every program the test started is gone. */
  const assertAllDead = Effect.gen(function* () {
    const all = yield* calls;
    const alive = yield* Effect.filter(all, (c) => isAlive(c.pid));
    assert.deepStrictEqual(alive, []);
  });
  return { dir, script, calls, callsOf, assertAllDead };
});

type Workspace = Effect.Success<typeof workspace>;

/** `effect` again every 20 ms until `ok` holds, 3 s at most. */
const eventually = <A, E, R>(effect: Effect.Effect<A, E, R>, ok: (a: A) => boolean) =>
  effect.pipe(Effect.repeat({ until: ok, schedule: Schedule.spaced('20 millis') }), Effect.timeout('3 seconds'));

const settingsOf = (collectors: Partial<CollectorSettings['collectors']> = {}): CollectorSettings => ({
  collectors: { nvml: true, system: true, disk: true, ...collectors },
  pollIntervalMs: 1000,
  hiddenGpus: [],
});

type Services = FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner | PciIds;

type Options = Parameters<typeof Collectors.layerWith>[0];

/**
 * `test` in a workspace with the collectors built by `options` (perf `perf` of the workspace when not given); once
 * their scope is closed, every fake they started must be dead.
 */
const withCollectors = <A, E, EO>(
  options: (ws: Workspace) => Effect.Effect<Options, EO, Services | Scope.Scope>,
  test: (collectors: Collectors['Service'], ws: Workspace) => Effect.Effect<A, E, Services | Scope.Scope>,
): Effect.Effect<void, E | EO | Error, Services> =>
  Effect.scoped(
    Effect.gen(function* () {
      const ws = yield* workspace;
      const o = yield* options(ws);
      yield* Layer.build(Collectors.layerWith(o)).pipe(
        Effect.flatMap((context) => test(Context.get(context, Collectors), ws)),
        Effect.scoped,
      );
      yield* ws.assertAllDead;
    }),
  );

/** A fake perf that runs until it is killed. */
const fakePerf = (ws: Workspace) => ws.script('perf', 'exec sleep 60');

/** A fake NVML sampler: it would be recorded if it were started. */
const fakeNvml = (ws: Workspace) => ws.script('nvml', 'exec sleep 60');

const Platform = Layer.provideMerge(PciIds.layer, NodeServices.layer);

layer(Platform, { excludeTestServices: true })('Collectors', (it) => {
  it.effect('with no NVML library and no nvidia-smi, the collectors start and read no GPU', () =>
    withCollectors(
      (ws) =>
        Effect.gen(function* () {
          // nvidia-smi without a driver: it fails at once.
          const smi = yield* ws.script('nvidia-smi', 'echo "NVIDIA-SMI has failed" >&2; exit 9');
          return {
            initial: settingsOf(),
            nvmlLib: Option.some(`${MISSING}/libnvidia-ml.so.1`),
            nvidiaSmi: smi,
            perfBin: MISSING,
          };
        }),
      (collectors, ws) =>
        Effect.gen(function* () {
          assert.strictEqual(collectors.nvidiaSource, 'nvidia-smi');
          const system = yield* collectors.nvmlSystem;
          assert.isNull(system);
          yield* eventually(ws.callsOf('nvidia-smi', '-lms'), (c) => c.length === 1);
          yield* Effect.sleep('500 millis');
          const gpus = yield* collectors.nvidia.gpus;
          assert.deepStrictEqual(gpus, []);
          // A stream that died is not started again.
          const starts = yield* ws.callsOf('nvidia-smi', '-lms');
          assert.lengthOf(starts, 1);
        }),
    ),
  );

  it.effect('collectors.nvml off starts nvidia-smi without trying NVML', () =>
    withCollectors(
      (ws) =>
        Effect.gen(function* () {
          const smi = yield* ws.script('nvidia-smi', `echo '${LINE}'; exec sleep 60`);
          const nvml = yield* fakeNvml(ws);
          return {
            initial: settingsOf({ nvml: false }),
            nvmlLib: Option.none(),
            nvmlCommand: { cmd: nvml, args: [] },
            nvidiaSmi: smi,
            perfBin: MISSING,
          };
        }),
      (collectors, ws) =>
        Effect.gen(function* () {
          assert.strictEqual(collectors.nvidiaSource, 'nvidia-smi');
          const started = yield* eventually(ws.callsOf('nvidia-smi', '-lms'), (c) => c.length === 1);
          assert.include(started[0]?.args ?? [], '1000');
          const gpus = yield* eventually(collectors.nvidia.gpus, (g) => g.length === 1);
          assert.strictEqual(gpus[0]?.name, 'NVIDIA GeForce RTX 5070 Ti');
          const nvmlStarts = yield* ws.callsOf('nvml');
          assert.deepStrictEqual(nvmlStarts, []);
        }),
    ),
  );

  it.effect('collectors.nvml is read at startup only', () =>
    withCollectors(
      (ws) =>
        Effect.gen(function* () {
          const nvml = yield* fakeNvml(ws);
          return {
            initial: settingsOf({ nvml: false }),
            nvmlLib: Option.none(),
            nvmlCommand: { cmd: nvml, args: [] },
            nvidiaSmi: MISSING,
            perfBin: MISSING,
          };
        }),
      (collectors, ws) =>
        Effect.gen(function* () {
          yield* collectors.configure(settingsOf({ nvml: true }));
          assert.strictEqual(collectors.nvidiaSource, 'nvidia-smi');
          const system = yield* collectors.nvmlSystem;
          assert.isNull(system);
          const nvmlStarts = yield* ws.callsOf('nvml');
          assert.deepStrictEqual(nvmlStarts, []);
        }),
    ),
  );

  it.effect('the system and disk switches apply live', () =>
    withCollectors(
      (ws) =>
        Effect.gen(function* () {
          const perf = yield* fakePerf(ws);
          return { initial: settingsOf({ nvml: false }), nvmlLib: Option.none(), nvidiaSmi: MISSING, perfBin: perf };
        }),
      (collectors, ws) =>
        Effect.gen(function* () {
          const [first] = yield* eventually(ws.callsOf('perf', '-a'), (c) => c.length === 1);
          const system = yield* collectors.system.pipe(Effect.map(Option.getOrThrow));
          const machine = yield* system.sample;
          assert.isNotNull(machine.mem);
          const disk = yield* collectors.disk.pipe(Effect.map(Option.getOrThrow));
          const disks = yield* disk.sample(null);
          assert.isNull(disks.model);

          yield* collectors.configure(settingsOf({ nvml: false, system: false }));
          const systemOff = yield* collectors.system;
          assert.isTrue(Option.isNone(systemOff));
          const diskStill = yield* collectors.disk;
          assert.isTrue(Option.isSome(diskStill));
          yield* eventually(isAlive(first?.pid ?? 0), (alive) => !alive);

          yield* collectors.configure(settingsOf({ nvml: false, system: false, disk: false }));
          const diskOff = yield* collectors.disk;
          assert.isTrue(Option.isNone(diskOff));

          yield* collectors.configure(settingsOf({ nvml: false }));
          const [systemOn, diskOn] = yield* Effect.all([collectors.system, collectors.disk]);
          assert.isTrue(Option.isSome(systemOn));
          assert.isTrue(Option.isSome(diskOn));
          yield* eventually(ws.callsOf('perf', '-a'), (c) => c.length === 2);
        }),
    ),
  );

  it.effect('configure calls run one at a time', () =>
    withCollectors(
      (ws) =>
        Effect.gen(function* () {
          const perf = yield* fakePerf(ws);
          return {
            initial: settingsOf({ nvml: false, system: false }),
            nvmlLib: Option.none(),
            nvidiaSmi: MISSING,
            perfBin: perf,
          };
        }),
      (collectors, ws) =>
        Effect.gen(function* () {
          // Both switch the system collector on: the second finds the first's sampler and starts no other perf.
          const on = settingsOf({ nvml: false });
          yield* Effect.all([collectors.configure(on), collectors.configure(on)], { concurrency: 2 });
          yield* eventually(ws.callsOf('perf', '-a'), (c) => c.length >= 1);
          yield* Effect.sleep('300 millis');
          const starts = yield* ws.callsOf('perf', '-a');
          assert.lengthOf(starts, 1);
        }),
    ),
  );

  it.effect('a change the collectors cannot apply fails with CollectorsNotApplied', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      // The disks cannot be listed: a defect, not a missing folder.
      const broken = FileSystem.FileSystem.of({
        ...fs,
        readDirectory: (path, options) =>
          path === '/sys/block' ? Effect.die(new Error('sysfs unreadable')) : fs.readDirectory(path, options),
      });
      yield* withCollectors(
        () =>
          Effect.succeed({
            initial: settingsOf({ nvml: false, disk: false }),
            nvmlLib: Option.none(),
            nvidiaSmi: MISSING,
            perfBin: MISSING,
          }),
        (collectors) =>
          Effect.gen(function* () {
            const error = yield* Effect.flip(collectors.configure(settingsOf({ nvml: false })));
            assert.strictEqual(error._tag, 'CollectorsNotApplied');
            assert.strictEqual(error.message, 'sysfs unreadable');
            const disk = yield* collectors.disk;
            assert.isTrue(Option.isNone(disk));
            // The next change still applies.
            yield* collectors.configure(settingsOf({ nvml: false, system: false, disk: false }));
            const system = yield* collectors.system;
            assert.isTrue(Option.isNone(system));
          }),
      ).pipe(Effect.provideService(FileSystem.FileSystem, broken));
    }),
  );

  it.effect('layer reads the settings, LLAMA_WEBUI_NVML_LIB and LLAMA_WEBUI_NVIDIA_SMI', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const ws = yield* workspace;
        const smi = yield* ws.script('nvidia-smi', 'exec sleep 60');
        const env = { LLAMA_WEBUI_NVML_LIB: `${MISSING}/libnvidia-ml.so.1`, LLAMA_WEBUI_NVIDIA_SMI: smi };
        const stored = yield* Layer.build(SettingsRepo.layer.pipe(Layer.provideMerge(Db.layerAt(':memory:'))));
        yield* SettingsRepo.use((repo) => repo.patch({ pollIntervalMs: 2000 })).pipe(Effect.provideContext(stored));
        const Built = Collectors.layer.pipe(Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env }))));
        yield* Layer.build(Built).pipe(
          Effect.flatMap((context) =>
            Effect.gen(function* () {
              const collectors = Context.get(context, Collectors);
              // NVML was tried (on by default) with the missing library, then nvidia-smi at the stored interval.
              assert.strictEqual(collectors.nvidiaSource, 'nvidia-smi');
              const [started] = yield* eventually(ws.callsOf('nvidia-smi', '-lms'), (c) => c.length === 1);
              assert.include(started?.args ?? [], '2000');
            }),
          ),
          Effect.provideContext(stored),
          Effect.scoped,
        );
        yield* ws.assertAllDead;
      }),
    ),
  );
});
