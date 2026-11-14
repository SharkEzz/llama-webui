import { NodeServices } from '@effect/platform-node';
import { assert, layer } from '@effect/vitest';
import { DEFAULT_SETTINGS, type Settings, Snapshot, type WsMessage } from '@llama-webui/shared';
import {
  Array as Arr,
  Cause,
  Clock,
  ConfigProvider,
  Context,
  Duration,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Logger,
  Option,
  Path,
  Queue,
  Record as Rec,
  Ref,
  Schedule,
  Schema,
  Scope,
  String as Str,
} from 'effect';
import { ChildProcessSpawner } from 'effect/process';
import { Collectors, CollectorsNotApplied } from '../collectors/Collectors.ts';
import * as Db from '../db/Db.ts';
import { PciIds } from '../hardware/PciIds.ts';
import { LlamaHttp } from '../llama/LlamaHttp.ts';
import { isAlive } from '../llama/procScan.ts';
import { LogRing } from '../logs/LogRing.ts';
import { CLOSE_BOUND } from '../process/followed.ts';
import { ProfilesRepo } from '../profiles/ProfilesRepo.ts';
import { SettingsRepo } from '../settings/SettingsRepo.ts';
import { buildCommand } from '../supervisor/command.ts';
import { Supervisor } from '../supervisor/Supervisor.ts';
import { FAKE, freePort, httpStub } from '../testing/llama.ts';
import { stuckRelease } from '../testing/stuckRelease.ts';
import { WsHub } from '../ws/WsHub.ts';
import { Monitor } from './Monitor.ts';

/** No such file: the NVML library, nvidia-smi and perf are missing. */
const MISSING = '/nonexistent/llama-webui-test';

/** The snapshots the hub of the test was given to publish, in order. */
class Published extends Context.Service<Published, Queue.Queue<Snapshot>>()(
  '@llama-webui/app/server/monitor/Monitor.test/Published',
) {}

/** A hub that hands the snapshots it publishes to `Published`. */
const RecordingHub = Layer.effect(
  WsHub,
  Effect.gen(function* () {
    const published = yield* Published;
    return {
      publish: (message: WsMessage) =>
        message.type === 'snapshot' ? Effect.asVoid(Queue.offer(published, message.payload)) : Effect.void,
      size: Effect.succeed(0),
      attach: () => Effect.void,
    };
  }),
);

/** What the monitor runs on, but the collectors: a supervisor, the repositories on a new database, the platform. */
const Base = Supervisor.layerWith({ killTimeout: '1 second', healthPoll: '50 millis' }).pipe(
  Layer.provideMerge(Layer.mergeAll(LogRing.layer, LlamaHttp.layer)),
  Layer.provideMerge(Layer.mergeAll(RecordingHub, SettingsRepo.layer, ProfilesRepo.layer)),
  Layer.provideMerge(Layer.effect(Published, Queue.unbounded<Snapshot>())),
  Layer.provideMerge(Db.layerAt(':memory:')),
  Layer.provideMerge(PciIds.layer),
  Layer.provideMerge(NodeServices.layer),
);

type Services =
  | Supervisor
  | SettingsRepo
  | ProfilesRepo
  | Published
  | LlamaHttp
  | FileSystem.FileSystem
  | Path.Path
  | ChildProcessSpawner.ChildProcessSpawner
  | Scope.Scope;

interface Options {
  /** A change of the stored settings before the start, over a 250 ms interval and no NVML. */
  readonly patch?: Readonly<Record<string, unknown>>;
  /** The collectors as the monitor sees them. */
  readonly collectors?: (collectors: Collectors['Service']) => Collectors['Service'];
  /** The NVML sampler the collectors start (with `collectors.nvml` on in `patch`). */
  readonly nvmlCommand?: { readonly cmd: string; readonly args: ReadonlyArray<string> };
  /** How long the collectors wait for the sampler's `ready`. */
  readonly readyTimeout?: Duration.Input;
  /** The spawner of the collectors' programs. */
  readonly spawner?: ChildProcessSpawner.ChildProcessSpawner['Service'];
  /** How long the collectors take to be built, past their own start. */
  readonly buildDelay?: Duration.Input;
  /** How long the monitor waits for its collectors. */
  readonly collectorsWait?: Duration.Input;
}

/** The settings of the test: every 250 ms, 30 s of history (120 points), NVML off. */
const patchOf = (options: Options) => ({
  pollIntervalMs: 250,
  historySeconds: 30,
  collectors: { nvml: false, system: true, disk: true },
  ...options.patch,
});

/** The monitor on collectors that find no program, the settings of `options` stored first. */
const monitorLayer = (options: Options) =>
  Effect.gen(function* () {
    const repo = yield* SettingsRepo;
    const settings = yield* repo.patch(patchOf(options));
    const platform = yield* ChildProcessSpawner.ChildProcessSpawner;
    const found = Collectors.layerWith({
      initial: settings,
      nvmlLib: Option.some(`${MISSING}/libnvidia-ml.so.1`),
      nvidiaSmi: MISSING,
      perfBin: MISSING,
      ...(options.nvmlCommand === undefined ? {} : { nvmlCommand: options.nvmlCommand }),
      ...(options.readyTimeout === undefined ? {} : { readyTimeout: options.readyTimeout }),
    }).pipe(Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, options.spawner ?? platform)));
    const change = options.collectors;
    const changed =
      change === undefined
        ? found
        : Layer.effect(
            Collectors,
            Collectors.use((original) => Effect.succeed(change(original))),
          ).pipe(Layer.provide(found));
    const delay = options.buildDelay;
    const collectors = delay === undefined ? changed : Layer.unwrap(Effect.as(Effect.sleep(delay), changed));
    const layer = Monitor.layerWith({
      modelDiskRetry: '30 seconds',
      appsEvery: 5,
      collectors,
      ...(options.collectorsWait === undefined ? {} : { collectorsWait: options.collectorsWait }),
    });
    return { layer, settings };
  });

/** `test` with a monitor on collectors that find no program, the settings of `options` stored first. */
const withMonitor = <A, E>(
  options: Options,
  test: (monitor: Monitor['Service'], settings: Settings) => Effect.Effect<A, E, Services>,
) =>
  Effect.gen(function* () {
    const { layer, settings } = yield* monitorLayer(options);
    const context = yield* Layer.build(layer);
    return yield* test(Context.get(context, Monitor), settings);
  }).pipe(Effect.scoped);

/** The next published snapshot, `within` at most. */
const next = (within: Duration.Input = '2 seconds') =>
  Published.use((published) => Queue.take(published)).pipe(Effect.timeout(within));

/** Drops the snapshots published so far. */
const drain = Published.use((published) => Effect.asVoid(Queue.clear(published)));

/** A profile of the fake on a free port, started by the supervisor and loaded: its pid. */
const startFake = Effect.gen(function* () {
  const supervisor = yield* Supervisor;
  const profiles = yield* ProfilesRepo;
  const port = yield* freePort;
  const profile = yield* profiles.create({ name: 'fake', model: 'm.gguf', port, args: [], env: {} });
  const settings = { ...DEFAULT_SETTINGS, binary: FAKE, host: '127.0.0.1' };
  const cmd = yield* buildCommand({ profile, settings });
  yield* supervisor.start(cmd);
  const ready = yield* supervisor.state.pipe(
    Effect.repeat({ until: (s) => s.kind === 'ready', schedule: Schedule.spaced('20 millis') }),
    Effect.timeout('5 seconds'),
  );
  return ready.kind === 'ready' ? ready.pid : -1;
});

/** Stops the fake: its process is gone. */
const stopFake = (pid: number) =>
  Effect.gen(function* () {
    yield* Supervisor.use((supervisor) => supervisor.stop);
    const alive = yield* isAlive(pid);
    assert.isFalse(alive);
  });

layer(Base, { excludeTestServices: true, buildPerTest: true })('Monitor', (it) => {
  it.effect('the first snapshot is published and served by latest', () =>
    Effect.gen(function* () {
      const pid = yield* startFake;
      yield* withMonitor({}, (monitor) =>
        Effect.gen(function* () {
          const source = yield* monitor.nvidiaSource;
          assert.strictEqual(source, 'nvidia-smi');
          const first = yield* next();
          assert.strictEqual(first.tick, 1);
          assert.strictEqual(first.health, 'ok');
          assert.lengthOf(first.slots ?? [], 1);
          assert.isNotNull(first.proc);
          assert.deepStrictEqual(first.allGpus, []);
          assert.deepStrictEqual(first.history, { intervalMs: 250, capacity: 120 });
          yield* Schema.encodeUnknownEffect(Snapshot)(first);
          const latest = yield* monitor.latest;
          assert.isAtLeast(latest?.tick ?? 0, 1);
          assert.strictEqual(latest?.health, 'ok');
          const history = yield* monitor.history;
          assert.isAtLeast(history.times.length, 1);
          assert.deepStrictEqual([history.intervalMs, history.capacity], [250, 120]);
        }),
      );
      yield* stopFake(pid);
    }),
  );

  it.effect('the next tick comes after a llama-server that never answers', () =>
    Effect.gen(function* () {
      // Answers the first /health (the detection), then nothing.
      let answered = false;
      const silent = yield* httpStub((_req, res) => {
        if (answered) return;
        answered = true;
        res.writeHead(200, { 'content-type': 'application/json' }).end('{"status":"ok"}');
      });
      const supervisor = yield* Supervisor;
      const detected = yield* supervisor.detectExternal(silent.port);
      assert.isTrue(detected);
      yield* withMonitor({}, () =>
        Effect.gen(function* () {
          const start = yield* Clock.currentTimeMillis;
          const both = yield* Effect.all([next(), next()]);
          const took = (yield* Clock.currentTimeMillis) - start;
          assert.deepStrictEqual(
            Arr.map(both, (s) => s.health),
            ['down', 'down'],
          );
          assert.isBelow(took, 2000);
        }),
      );
    }),
  );

  it.effect('configure resizes the history keeping the newest points and moves the next tick to the new interval', () =>
    withMonitor({}, (monitor) =>
      Effect.gen(function* () {
        const repo = yield* SettingsRepo;
        for (let i = 0; i < 4; i++) yield* next();
        const before = yield* monitor.history;
        assert.isAtLeast(before.times.length, 4);
        yield* repo.patch({ pollIntervalMs: 10_000 });
        yield* monitor.configure;
        const shrunk = yield* monitor.history;
        assert.deepStrictEqual([shrunk.intervalMs, shrunk.capacity, shrunk.times.length], [10_000, 3, 3]);
        // The newest points: none older than the third newest before the change.
        assert.isAtLeast(shrunk.times[0] ?? 0, before.times[before.times.length - 3] ?? Number.POSITIVE_INFINITY);
        for (const values of Rec.values(shrunk.series)) assert.lengthOf(values, 3);
        // At 10 s, no tick comes now.
        yield* Effect.sleep('300 millis');
        yield* drain;
        const t0 = yield* Clock.currentTimeMillis;
        yield* repo.patch({ pollIntervalMs: 250 });
        yield* monitor.configure;
        const after = yield* next('1 second');
        assert.isBelow((yield* Clock.currentTimeMillis) - t0, 1000);
        assert.deepStrictEqual(after.history, { intervalMs: 250, capacity: 120 });
        const grown = yield* monitor.history;
        assert.isAtLeast(grown.times.length, 4);
        assert.deepStrictEqual(Arr.take(grown.times, 3), shrunk.times);
      }),
    ),
  );

  it.effect('settings become current only once the collectors accepted them', () =>
    Effect.gen(function* () {
      const refuse = (collectors: Collectors['Service']): Collectors['Service'] => ({
        ...collectors,
        configure: () => Effect.fail(CollectorsNotApplied.make({ message: 'refused' })),
      });
      yield* withMonitor({ collectors: refuse }, (monitor) =>
        Effect.gen(function* () {
          yield* next();
          yield* SettingsRepo.use((repo) => repo.patch({ pollIntervalMs: 500, historySeconds: 60 }));
          const error = yield* Effect.flip(monitor.configure);
          assert.strictEqual(error._tag, 'CollectorsNotApplied');
          const history = yield* monitor.history;
          assert.deepStrictEqual([history.intervalMs, history.capacity], [250, 120]);
          yield* drain;
          const snapshot = yield* next('1 second');
          assert.deepStrictEqual(snapshot.history, { intervalMs: 250, capacity: 120 });
        }),
      );
    }),
  );

  it.effect('a model disk lookup that never ends does not hold a tick', () =>
    Effect.gen(function* () {
      const lookups = yield* Ref.make(0);
      const stuck = (collectors: Collectors['Service']): Collectors['Service'] => ({
        ...collectors,
        disk: Effect.map(
          collectors.disk,
          Option.map((disk) => ({
            ...disk,
            resolveModelDisk: () =>
              Effect.andThen(
                Ref.update(lookups, (n) => n + 1),
                Effect.never,
              ),
          })),
        ),
      });
      const pid = yield* startFake;
      yield* withMonitor({ collectors: stuck }, () =>
        Effect.gen(function* () {
          const snapshots = yield* Effect.all([next(), next(), next()]);
          for (const s of snapshots) {
            assert.isNotNull(s.disk);
            assert.isNull(s.disk?.model);
          }
          const count = yield* Ref.get(lookups);
          assert.strictEqual(count, 1);
        }),
      );
      yield* stopFake(pid);
    }),
  );

  it.effect('a tick that dies is logged and the next one still comes', () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make(0);
      const dyingOnce = (collectors: Collectors['Service']): Collectors['Service'] => ({
        ...collectors,
        system: Effect.flatMap(
          Ref.getAndUpdate(calls, (n) => n + 1),
          (n) => (n === 0 ? Effect.die(new Error('boom')) : collectors.system),
        ),
      });
      const errors: Array<{ readonly message: unknown; readonly cause: string }> = [];
      const logger = Logger.make(({ logLevel, message, cause }) => {
        if (logLevel === 'Error') errors.push({ message, cause: Cause.pretty(cause) });
      });
      yield* withMonitor({ collectors: dyingOnce }, () =>
        Effect.gen(function* () {
          const first = yield* next();
          assert.strictEqual(first.tick, 2);
          const second = yield* next();
          assert.strictEqual(second.tick, 3);
        }),
      ).pipe(Effect.provideService(Logger.CurrentLoggers, new Set([logger])));
      // The first tick's death, logged once with its cause.
      assert.lengthOf(errors, 1);
      assert.deepStrictEqual(errors[0]?.message, ['monitoring tick']);
      assert.include(errors[0]?.cause ?? '', 'boom');
    }),
  );

  it.effect("the monitor's layer is built before its collectors answer", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: 'lw-monitor-' });
      const fake = path.resolve(import.meta.dirname, '../testing/fixtures/fakeNvml.ts');
      const options: Options = {
        patch: { collectors: { nvml: true, system: true, disk: true } },
        nvmlCommand: { cmd: process.execPath, args: [fake, 'slow-ready', dir] },
      };
      const startedAt = yield* Clock.currentTimeMillis;
      yield* withMonitor(options, (monitor) =>
        Effect.gen(function* () {
          // Built while the sampler has not answered (it answers 1.5 s after its start).
          const builtIn = (yield* Clock.currentTimeMillis) - startedAt;
          assert.isBelow(builtIn, 500);
          const latest = yield* monitor.latest;
          assert.isNull(latest);
          const history = yield* monitor.history;
          assert.deepStrictEqual([history.intervalMs, history.capacity, history.times], [250, 120, []]);
          // The ticks start once the collectors are up, NVML among them.
          const first = yield* next('5 seconds');
          assert.isAtLeast((yield* Clock.currentTimeMillis) - startedAt, 1500);
          assert.strictEqual(first.tick, 1);
          assert.deepStrictEqual(
            Arr.map(first.allGpus, (gpu) => gpu.key),
            ['nvidia:GPU-fake'],
          );
          const source = yield* monitor.nvidiaSource;
          assert.strictEqual(source, 'nvml');
        }),
      );
      // The end of the monitor's layer killed the sampler.
      const recorded = yield* fs.readFileString(path.join(dir, 'pids'));
      const pids = Arr.map(Arr.filter(Str.split(recorded, '\n'), Str.isNonEmpty), Number);
      assert.lengthOf(pids, 1);
      const alive = yield* Effect.filter(pids, isAlive);
      assert.deepStrictEqual(alive, []);
    }),
  );

  it.effect('configure applies the stored settings, whatever a caller saw', () =>
    withMonitor({}, (monitor) =>
      Effect.gen(function* () {
        const repo = yield* SettingsRepo;
        yield* next();
        // Two changes saved, then applied in either order: the monitor ends on the last one saved.
        yield* repo.patch({ historySeconds: 60 });
        yield* repo.patch({ historySeconds: 120 });
        yield* Effect.all([monitor.configure, monitor.configure], { concurrency: 2 });
        const history = yield* monitor.history;
        assert.deepStrictEqual([history.intervalMs, history.capacity], [250, 480]);
      }),
    ),
  );

  it.effect('collectors not up within the wait refuse a change, then apply what is stored once they are', () =>
    withMonitor({ buildDelay: '800 millis', collectorsWait: '200 millis' }, (monitor) =>
      Effect.gen(function* () {
        const repo = yield* SettingsRepo;
        yield* repo.patch({ historySeconds: 60 });
        const [elapsed, refused] = yield* Effect.timed(Effect.flip(monitor.configure));
        assert.strictEqual(refused.message, 'the collectors are not up yet');
        assert.isBelow(Duration.toMillis(elapsed), 600);
        const source = yield* monitor.nvidiaSource;
        assert.strictEqual(source, 'nvidia-smi');
        // Built 800 ms after the start: the change refused is applied before the first tick.
        const first = yield* next('3 seconds');
        assert.deepStrictEqual(first.history, { intervalMs: 250, capacity: 240 });
      }),
    ),
  );

  it.effect(
    'a sampler killed but stuck in the kernel at startup: the monitor falls back to nvidia-smi and answers',
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: 'lw-monitor-' });
        const fake = path.resolve(import.meta.dirname, '../testing/fixtures/fakeNvml.ts');
        const stuck = yield* stuckRelease;
        const options: Options = {
          patch: { collectors: { nvml: true, system: true, disk: true } },
          nvmlCommand: { cmd: process.execPath, args: [fake, 'silent', dir] },
          readyTimeout: '300 millis',
          spawner: stuck.spawner,
        };
        yield* withMonitor(options, (monitor) =>
          Effect.gen(function* () {
            const [elapsed, source] = yield* Effect.timed(monitor.nvidiaSource);
            assert.strictEqual(source, 'nvidia-smi');
            assert.isBelow(Duration.toMillis(elapsed), 300 + Duration.toMillis(CLOSE_BOUND) + 1000);
            const first = yield* next('3 seconds');
            assert.strictEqual(first.tick, 1);
            yield* SettingsRepo.use((repo) => repo.patch({ historySeconds: 60 }));
            yield* monitor.configure.pipe(Effect.timeout('2 seconds'));
            const history = yield* monitor.history;
            assert.strictEqual(history.capacity, 240);
          }),
        );
        const recorded = yield* fs.readFileString(path.join(dir, 'pids'));
        const pids = Arr.map(Arr.filter(Str.split(recorded, '\n'), Str.isNonEmpty), Number);
        const alive = yield* Effect.filter(pids, isAlive);
        assert.deepStrictEqual(alive, []);
        yield* stuck.unstick;
      }),
  );

  it.effect("the end of the monitor's layer returns within the bound when its sampler is stuck in the kernel", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: 'lw-monitor-' });
      const fake = path.resolve(import.meta.dirname, '../testing/fixtures/fakeNvml.ts');
      const stuck = yield* stuckRelease;
      const { layer } = yield* monitorLayer({
        patch: { collectors: { nvml: true, system: true, disk: true } },
        nvmlCommand: { cmd: process.execPath, args: [fake, 'ready-then-sample', dir] },
        spawner: stuck.spawner,
      });
      const scope = yield* Scope.make();
      const context = yield* Layer.buildWithScope(layer, scope);
      const source = yield* Context.get(context, Monitor).nvidiaSource;
      assert.strictEqual(source, 'nvml');
      yield* next('3 seconds');
      const [elapsed] = yield* Effect.timed(Scope.close(scope, Exit.void));
      assert.isBelow(Duration.toMillis(elapsed), Duration.toMillis(CLOSE_BOUND) + 700);
      const recorded = yield* fs.readFileString(path.join(dir, 'pids'));
      const pids = Arr.map(Arr.filter(Str.split(recorded, '\n'), Str.isNonEmpty), Number);
      assert.lengthOf(pids, 1);
      const alive = yield* Effect.filter(pids, isAlive);
      assert.deepStrictEqual(alive, []);
      yield* stuck.unstick;
    }),
  );

  it.effect('collectors that cannot start leave the monitor without snapshots, every change refused', () =>
    Effect.gen(function* () {
      const broken = Layer.effect(Collectors, Effect.die('no collectors here'));
      const context = yield* Layer.build(
        Monitor.layerWith({ modelDiskRetry: '30 seconds', appsEvery: 5, collectors: broken }),
      );
      const monitor = Context.get(context, Monitor);
      const refused = yield* Effect.flip(monitor.configure);
      assert.strictEqual(refused._tag, 'CollectorsNotApplied');
      const source = yield* monitor.nvidiaSource;
      const system = yield* monitor.nvmlSystem;
      assert.strictEqual(source, 'nvidia-smi');
      assert.isNull(system);
      yield* Effect.sleep('300 millis');
      const latest = yield* monitor.latest;
      assert.isNull(latest);
      const published = yield* Published;
      const size = yield* Queue.size(published);
      assert.strictEqual(size, 0);
    }),
  );

  it.effect('the stub answers an empty history and no snapshot', () =>
    Effect.gen(function* () {
      const stub = Monitor.layer.pipe(
        Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: { LLAMA_WEBUI_TEST_MONITOR: 'stub' } }))),
      );
      const context = yield* Layer.build(stub);
      const monitor = Context.get(context, Monitor);
      const latest = yield* monitor.latest;
      const history = yield* monitor.history;
      const system = yield* monitor.nvmlSystem;
      const source = yield* monitor.nvidiaSource;
      assert.isNull(latest);
      assert.deepStrictEqual(history, { intervalMs: 1000, capacity: 0, at: 0, times: [], series: {} });
      assert.strictEqual(source, 'nvml');
      assert.isNull(system);
      yield* monitor.configure;
      yield* Effect.sleep('300 millis');
      const published = yield* Published;
      const size = yield* Queue.size(published);
      assert.strictEqual(size, 0);
    }),
  );
});
