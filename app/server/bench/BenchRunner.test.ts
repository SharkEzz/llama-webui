import { assert, describe, it } from '@effect/vitest';
import {
  type BenchLive,
  type BenchRun,
  BenchSpec,
  type BenchSpecInput,
  ctxFromArgs,
  type ServerState,
  SweepSpec,
  type SweepSpecInput,
  sweepCtx,
  type WsMessage,
} from '@llama-webui/shared';
import {
  Array as Arr,
  Context,
  Deferred,
  type Duration,
  Effect,
  Fiber,
  FileSystem,
  Layer,
  Option,
  Path,
  Ref,
  Schedule,
  Schema,
  type Scope,
  String as Str,
} from 'effect';
import { TestClock } from 'effect/testing';
import { LogRing } from '../logs/LogRing.ts';
import { ProfilesRepo } from '../profiles/ProfilesRepo.ts';
import { Shutdown } from '../runtime/Shutdown.ts';
import { SettingsRepo } from '../settings/SettingsRepo.ts';
import { buildCommand } from '../supervisor/command.ts';
import { Supervisor } from '../supervisor/Supervisor.ts';
import { FAKE, freePort, httpStub } from '../testing/llama.ts';
import { ServicesWithoutBench } from '../testing/services.ts';
import { WsHub } from '../ws/WsHub.ts';
import { BenchHardware } from './BenchHardware.ts';
import { BenchRunner, makeThrottle } from './BenchRunner.ts';
import { BenchRunsRepo } from './BenchRunsRepo.ts';
import { SweepsRepo } from './SweepsRepo.ts';

/** What the runner published, in order. */
class Published extends Context.Service<Published, Ref.Ref<ReadonlyArray<WsMessage>>>()(
  '@llama-webui/app/server/bench/BenchRunner.test/Published',
) {}

/** The services of the routes but the runner (each test builds its own), and the recorder. */
const Base = Layer.effect(Published, Ref.make<ReadonlyArray<WsMessage>>([])).pipe(
  Layer.provideMerge(ServicesWithoutBench),
);

class Model extends Context.Service<Model, string>()('@llama-webui/app/server/bench/BenchRunner.test/Model') {}

type Services = Layer.Success<typeof Base> | Model | Scope.Scope;

const fresh = <A, E>(test: Effect.Effect<A, E, Services>) =>
  Layer.build(Base).pipe(
    Effect.flatMap((context) =>
      Effect.provideContext(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const dir = yield* fs.makeTempDirectoryScoped({ prefix: 'lw-bench-' });
          const model = path.join(dir, 'a.gguf');
          yield* fs.writeFileString(model, '');
          return yield* Effect.provideService(test, Model, model);
        }),
        context,
      ),
    ),
    Effect.scoped,
  );

/** A `WsHub` that records what is published, for the runner only. */
const RecordingHub = Layer.effect(
  WsHub,
  Effect.gen(function* () {
    const published = yield* Published;
    return WsHub.of({
      publish: (message) => Ref.update(published, Arr.append(message)),
      size: Effect.succeed(0),
      attach: () => Effect.void,
    });
  }),
);

const HARDWARE = { cpu: 'cpu', gpus: [], build: null };

/** The hardware read: fixed, or `hardware` (a read that never ends, to interrupt a request in it). */
const hardwareLayer = (hardware: Effect.Effect<typeof HARDWARE> = Effect.succeed(HARDWARE)) =>
  Layer.succeed(
    BenchHardware,
    BenchHardware.of({
      build: () => Effect.succeed(null),
      devices: () => Effect.die('not used'),
      listDevices: () => Effect.die('not used'),
      hardware: () => hardware,
    }),
  );

/** `test` with a runner of its own on the services of `fresh`, undone at its end. */
const withRunner =
  (options: { readonly pause?: Duration.Input; readonly hardware?: Effect.Effect<typeof HARDWARE> } = {}) =>
  <A, E, R>(test: Effect.Effect<A, E, R>) =>
    Layer.build(
      BenchRunner.layerWith({
        killTimeout: '1 second',
        pause: options.pause ?? '10 millis',
        stoppingTimeout: '60 seconds',
        liveThrottle: '250 millis',
      }).pipe(Layer.provide(Layer.mergeAll(RecordingHub, hardwareLayer(options.hardware)))),
    ).pipe(
      Effect.flatMap((context) => Effect.provideContext(test, context)),
      Effect.scoped,
    );

const specOf = (input: BenchSpecInput) => Schema.decodeEffect(BenchSpec)(input).pipe(Effect.orDie);
const sweepSpecOf = (input: SweepSpecInput) => Schema.decodeEffect(SweepSpec)(input).pipe(Effect.orDie);

/** The fake as llama-server (llama-bench next to it), with these variables; the trial's port is free. */
const useFake = Effect.fn(function* (env: Record<string, string> = {}) {
  const settings = yield* SettingsRepo;
  const port = yield* freePort;
  yield* settings.patch({ binary: FAKE, host: '127.0.0.1', port, env }).pipe(Effect.orDie);
});

const stateWhen = Effect.fnUntraced(function* (ok: (state: ServerState) => boolean) {
  const supervisor = yield* Supervisor;
  return yield* supervisor.state.pipe(
    Effect.repeat({ schedule: Schedule.spaced('10 millis'), until: ok }),
    Effect.timeout('10 seconds'),
  );
});

/** Profile `A` of the fake, on a port of its own, started and ready: its id. */
const startA = Effect.gen(function* () {
  const profiles = yield* ProfilesRepo;
  const settings = yield* SettingsRepo;
  const supervisor = yield* Supervisor;
  const port = yield* freePort;
  const profile = yield* profiles
    .create({ name: 'A', model: 'm.gguf', host: '127.0.0.1', port, args: [], env: {} })
    .pipe(Effect.orDie);
  const cmd = yield* buildCommand({ profile, settings: yield* settings.get });
  yield* supervisor.start(cmd).pipe(Effect.orDie);
  yield* stateWhen((s) => s.kind === 'ready');
  return profile;
});

/** What the gate did: its stop, its restarts and their failures, from the ring. */
const gateLines = Effect.gen(function* () {
  const ring = yield* LogRing;
  const lines = yield* ring.since(0);
  return Arr.filter(
    Arr.map(lines, (line) => line.text),
    (text) =>
      Str.startsWith('[bench] stopping llama-server')(text) ||
      Str.startsWith('[bench] restarting llama-server')(text) ||
      Str.startsWith('[bench] could not')(text),
  );
});
const gateWas = (expected: ReadonlyArray<string>) =>
  Effect.map(gateLines, (lines) => assert.deepStrictEqual(lines, expected));
const STOP_AND_RESTART = ['[bench] stopping llama-server for the benchmark', '[bench] restarting llama-server (A)'];

const published = Effect.flatMap(Published, Ref.get);
const progress = Effect.map(published, (all) =>
  Arr.flatMap(all, (m) => (m.type === 'bench-progress' ? [m.payload] : [])),
);
const benchRuns = Effect.map(published, (all) => Arr.flatMap(all, (m) => (m.type === 'bench-run' ? [m.payload] : [])));
const sweepProgress = Effect.map(published, (all) =>
  Arr.flatMap(all, (m) => (m.type === 'sweep-progress' ? [m.payload] : [])),
);

const until = <R>(check: Effect.Effect<boolean, never, R>) =>
  check.pipe(
    Effect.repeat({ schedule: Schedule.spaced('10 millis'), until: (ok) => ok }),
    Effect.timeout('20 seconds'),
    Effect.orDie,
  );
/** A one-off run ended: the live back to null. */
const runEnded = until(
  Effect.map(progress, (lives) => lives.length > 1 && Arr.last(lives).pipe(Option.exists((l) => l === null))),
);
/** A sweep ended: its progress back to null. */
const sweepEnded = until(
  Effect.map(sweepProgress, (lives) => lives.length > 0 && Arr.last(lives).pipe(Option.exists((l) => l === null))),
);
const lastRun = Effect.flatMap(benchRuns, (runs) => Effect.fromOption(Arr.last(runs)).pipe(Effect.orDie));

const itemsOf = Effect.fn(function* (sweepId: number) {
  const runs = yield* BenchRunsRepo;
  return yield* runs.list({
    kind: Option.none(),
    status: Option.none(),
    modelPath: Option.none(),
    sweep: sweepId,
    limit: 100,
  });
});

const sweepOfId = Effect.fn(function* (id: number) {
  const sweeps = yield* SweepsRepo;
  const found = yield* sweeps.get(id);
  return yield* Effect.fromOption(found).pipe(Effect.orDie);
});

/** A llama-bench sweep on the model, one item per -ncmoe value, started as E8's create will start it. */
const startSweepOf = Effect.fn(function* (values: ReadonlyArray<number>) {
  const runner = yield* BenchRunner;
  const runs = yield* BenchRunsRepo;
  const sweeps = yield* SweepsRepo;
  const model = yield* Model;
  const sweepSpec = yield* sweepSpecOf({
    name: 's',
    modelPath: model,
    preset: 'chat',
    r: 1,
    space: { ncmoe: [...values] },
  });
  const spec = yield* specOf({ kind: 'bench', modelPath: model, r: 1 });
  return yield* runner.startSweep({
    files: { modelPath: model, mmprojPath: null },
    stopServer: true,
    prepare: Effect.gen(function* () {
      const sweep = yield* sweeps.create(sweepSpec);
      yield* runs.enqueue(
        sweep.id,
        Arr.map(values, (v) => ({
          spec: { ...spec, params: { ncmoe: v } },
          label: `-ncmoe ${v}`,
          fit: 'fits' as const,
        })),
      );
      return sweep.id;
    }),
  });
});

const benchSpec = Effect.flatMap(Model, (model) => specOf({ kind: 'bench', modelPath: model, r: 2 }));
/** A one-off llama-bench run of the model, the server stopped for it. */
const startBench = Effect.gen(function* () {
  const runner = yield* BenchRunner;
  const spec = yield* benchSpec;
  return yield* runner.start(spec, { stopServer: true });
});

describe('BenchRunner', () => {
  it.live('restarts the server it stopped even when llama-bench fails', () =>
    Effect.gen(function* () {
      const runner = yield* BenchRunner;
      yield* useFake({ FAKE_BENCH_OOM: '1' });
      yield* startA;
      const run = yield* startBench;
      assert.strictEqual(run.status, 'running');
      yield* runEnded;
      const last = yield* lastRun;
      assert.strictEqual(last.id, run.id);
      assert.strictEqual(last.status, 'failed');
      assert.isTrue(Str.startsWith('Out of memory')(last.error ?? ''));
      yield* gateWas(STOP_AND_RESTART);
      const busy = yield* runner.busy;
      assert.isFalse(busy);
      yield* stateWhen((s) => s.kind === 'ready');
    }).pipe(withRunner(), fresh),
  );

  it.live('a successful run stores pp/tg and refuses a second run meanwhile', () =>
    Effect.gen(function* () {
      const runner = yield* BenchRunner;
      yield* useFake();
      yield* startA;
      const spec = yield* benchSpec;
      const refused = yield* Effect.flip(runner.start(spec, { stopServer: false }));
      assert.strictEqual(refused._tag, 'ServerRunning');
      yield* runner.start(spec, { stopServer: true });
      const again = yield* Effect.flip(runner.start(spec, { stopServer: true }));
      assert.strictEqual(again._tag, 'BenchRunning');
      assert.strictEqual(again.message, 'A benchmark is running');
      yield* runEnded;
      const last = yield* lastRun;
      assert.strictEqual(last.status, 'ok');
      assert.closeTo(last.pp?.tps ?? 0, 9817.38, 0.1);
      assert.closeTo(last.tg?.tps ?? 0, 410.81, 0.1);
      const all = yield* progress;
      const lives = Arr.filter(all, (l): l is BenchLive => l !== null);
      assert.isTrue(Arr.some(lives, (l) => l.phase === 'prompt' && l.step !== null));
      assert.isTrue(Arr.every(lives, (l) => l.lines.length <= 20));
      yield* gateWas(STOP_AND_RESTART);
    }).pipe(withRunner(), fresh),
  );

  it.live('a missing model is refused before anything stops', () =>
    Effect.gen(function* () {
      const runner = yield* BenchRunner;
      yield* useFake();
      yield* startA;
      const spec = yield* specOf({ kind: 'bench', modelPath: '/nulle/part.gguf' });
      const refused = yield* Effect.flip(runner.start(spec, { stopServer: true }));
      assert.strictEqual(refused._tag, 'BenchFileMissing');
      assert.strictEqual(refused.message, 'Model not found: /nulle/part.gguf');
      yield* gateWas([]);
      const busy = yield* runner.busy;
      assert.isFalse(busy);
      const state = yield* (yield* Supervisor).state;
      assert.strictEqual(state.kind, 'ready');
    }).pipe(withRunner(), fresh),
  );

  it.live('a failed restart is recorded on the run', () =>
    Effect.gen(function* () {
      const runner = yield* BenchRunner;
      const profiles = yield* ProfilesRepo;
      yield* useFake();
      const a = yield* startA;
      yield* startBench;
      // The profile now names a port another service holds: the restart fails.
      const other = yield* httpStub((_, res) => res.end('not llama'));
      yield* profiles
        .update({
          id: a.id,
          input: { name: 'A', model: 'm.gguf', host: '127.0.0.1', port: other.port, args: [], env: {} },
        })
        .pipe(Effect.orDie);
      yield* runEnded;
      const last = yield* lastRun;
      assert.strictEqual(last.status, 'ok');
      assert.include(
        last.error ?? '',
        `could not restart llama-server: port ${other.port} is in use by another service`,
      );
      const busy = yield* runner.busy;
      assert.isFalse(busy);
    }).pipe(withRunner(), fresh),
  );

  it.live('dispose (shutdown) saves the running sweep item and its sweep as interrupted', () =>
    Effect.gen(function* () {
      const shutdown = yield* Shutdown;
      yield* useFake({ FAKE_BENCH_STEP_MS: '200' });
      const sweep = yield* startSweepOf([1, 2]);
      yield* until(Effect.map(benchRuns, (runs) => Arr.some(runs, (r) => r.status === 'running')));
      yield* shutdown.run;
      const items = yield* itemsOf(sweep.id);
      assert.deepStrictEqual(
        Arr.map(items, (r) => [r.status, r.error]),
        [
          ['interrupted', 'interrupted (llama-webui stopped)'],
          ['queued', null],
        ],
      );
      const after = yield* sweepOfId(sweep.id);
      assert.strictEqual(after.status, 'interrupted');
    }).pipe(withRunner(), fresh),
  );

  it.live('a sweep stops the server once, continues after an OOM item and restarts it once', () =>
    Effect.gen(function* () {
      const runner = yield* BenchRunner;
      yield* useFake({
        FAKE_BENCH_OOM_ARG: '-ncmoe 4',
        FAKE_TG_BY_ARG: '-ncmoe 8=30;-ncmoe 16=20',
        FAKE_BENCH_STEP_MS: '5',
      });
      yield* startA;
      const sweep = yield* startSweepOf([4, 8, 16]);
      yield* sweepEnded;
      yield* gateWas(STOP_AND_RESTART);
      const done = yield* itemsOf(sweep.id);
      assert.deepStrictEqual(
        Arr.map(done, (r) => r.status),
        ['failed', 'ok', 'ok'],
      );
      assert.isTrue(Str.startsWith('Out of memory')(done[0]?.error ?? ''));
      const final = yield* sweepOfId(sweep.id);
      assert.strictEqual(final.status, 'done');
      assert.strictEqual(final.bestRunId, done[1]?.id);
      assert.strictEqual(done[1]?.tg?.tps, 30);
      const busy = yield* runner.busy;
      assert.isFalse(busy);
    }).pipe(withRunner(), fresh),
  );

  it.live('cancelSweep cancels the queue and releases the gate', () =>
    Effect.gen(function* () {
      const runner = yield* BenchRunner;
      yield* useFake({ FAKE_BENCH_STEP_MS: '200' });
      yield* startA;
      const sweep = yield* startSweepOf([1, 2, 3]);
      yield* until(Effect.map(benchRuns, (runs) => Arr.some(runs, (r) => r.status === 'running')));
      yield* runner.cancelSweep(sweep.id);
      yield* sweepEnded;
      const items = yield* itemsOf(sweep.id);
      assert.deepStrictEqual(
        Arr.map(items, (r) => r.status),
        ['cancelled', 'cancelled', 'cancelled'],
      );
      const final = yield* sweepOfId(sweep.id);
      assert.strictEqual(final.status, 'cancelled');
      yield* gateWas(STOP_AND_RESTART);
      const busy = yield* runner.busy;
      assert.isFalse(busy);
    }).pipe(withRunner(), fresh),
  );

  it.live('validating an interrupted sweep also finishes its interrupted items', () =>
    Effect.gen(function* () {
      const runner = yield* BenchRunner;
      const runs = yield* BenchRunsRepo;
      const sweeps = yield* SweepsRepo;
      yield* useFake({ FAKE_BENCH_STEP_MS: '5', FAKE_LOAD_MS: '50' });
      const sweep = yield* startSweepOf([1, 2]);
      yield* sweepEnded;
      // As after a Ctrl-C in the middle of item 2.
      const explored = yield* itemsOf(sweep.id);
      const second = Arr.findFirst(explored, (r) => r.sweepLabel === '-ncmoe 2');
      assert.isTrue(Option.isSome(second));
      if (Option.isSome(second)) yield* runs.finish(second.value.id, { status: 'interrupted', error: 'interrupted' });
      yield* sweeps.setStatus(sweep.id, 'interrupted');
      const ended = Effect.map(sweepProgress, (lives) => lives.length);
      const before = yield* ended;
      yield* runner.validate(sweep.id, { n: 1, stopServer: true });
      yield* until(
        Effect.map(
          sweepProgress,
          (lives) => lives.length > before + 1 && Arr.last(lives).pipe(Option.exists((l) => l === null)),
        ),
      );
      const items = yield* itemsOf(sweep.id);
      assert.deepStrictEqual(
        Arr.filter(items, (r) => r.status === 'interrupted'),
        [],
      );
      const final = yield* sweepOfId(sweep.id);
      assert.strictEqual(final.status, 'done');
    }).pipe(withRunner(), fresh),
  );

  it.live('server validation runs get the sweep context when the profile sets no -c (#24)', () =>
    Effect.gen(function* () {
      const runner = yield* BenchRunner;
      yield* useFake({ FAKE_BENCH_STEP_MS: '5', FAKE_LOAD_MS: '50' });
      const sweep = yield* startSweepOf([1, 2]);
      yield* sweepEnded;
      const before = (yield* sweepProgress).length;
      yield* runner.validate(sweep.id, { n: 1, stopServer: true });
      yield* until(
        Effect.map(
          sweepProgress,
          (lives) => lives.length > before + 1 && Arr.last(lives).pipe(Option.exists((l) => l === null)),
        ),
      );
      const validated = yield* itemsOf(sweep.id);
      const validation = Arr.findFirst(validated, (r) => r.kind === 'server');
      assert.isTrue(Option.isSome(validation));
      assert.isUndefined(ctxFromArgs(sweep.spec.serverArgs));
      assert.strictEqual(
        Option.match(validation, { onNone: () => undefined, onSome: (r) => ctxFromArgs(r.spec.serverArgs) }),
        sweepCtx(sweep.spec),
      );
    }).pipe(withRunner(), fresh),
  );

  it.live('resuming a sweep whose model was deleted is one 400, before anything stops (#37)', () =>
    Effect.gen(function* () {
      const runner = yield* BenchRunner;
      const runs = yield* BenchRunsRepo;
      const sweeps = yield* SweepsRepo;
      yield* useFake();
      yield* startA;
      const sweepSpec = yield* sweepSpecOf({
        name: 's',
        modelPath: '/nulle/part.gguf',
        preset: 'chat',
        r: 1,
        space: { ncmoe: [1] },
      });
      const sweep = yield* sweeps.create(sweepSpec);
      const spec = yield* specOf({ kind: 'bench', modelPath: '/nulle/part.gguf', r: 1 });
      yield* runs.enqueue(sweep.id, [{ spec, label: 'x', fit: 'fits' }]);
      yield* sweeps.setStatus(sweep.id, 'interrupted');
      const refused = yield* Effect.flip(runner.resume(sweep.id, { stopServer: true }));
      assert.strictEqual(refused._tag, 'BenchFileMissing');
      assert.strictEqual(refused.message, 'Model not found: /nulle/part.gguf');
      yield* gateWas([]);
      const after = yield* sweepOfId(sweep.id);
      assert.strictEqual(after.status, 'interrupted');
    }).pipe(withRunner(), fresh),
  );

  it.live('a request interrupted between its claim and its start leaves the runner free and llama-server back', () =>
    Effect.gen(function* () {
      const runner = yield* BenchRunner;
      const runs = yield* BenchRunsRepo;
      yield* useFake();
      yield* startA;
      const request = yield* Effect.forkChild(startBench);
      // The gate is taken and the server stopping; the hardware read never ends.
      yield* until(Effect.map(gateLines, (lines) => lines.length === 1));
      const taken = yield* runner.busy;
      assert.isTrue(taken);
      yield* Fiber.interrupt(request);
      const busy = yield* runner.busy;
      assert.isFalse(busy);
      yield* stateWhen((s) => s.kind === 'ready');
      yield* gateWas(STOP_AND_RESTART);
      const saved = yield* runs.list({
        kind: Option.none(),
        status: Option.none(),
        modelPath: Option.none(),
        sweep: 'all',
        limit: 10,
      });
      assert.deepStrictEqual(saved, []);
    }).pipe(withRunner({ hardware: Effect.never }), fresh),
  );

  it.live('resuming a sweep with nothing to resume is a 409 and stops nothing', () =>
    Effect.gen(function* () {
      const runner = yield* BenchRunner;
      const runs = yield* BenchRunsRepo;
      const sweeps = yield* SweepsRepo;
      const model = yield* Model;
      yield* useFake();
      yield* startA;
      const sweepSpec = yield* sweepSpecOf({
        name: 's',
        modelPath: model,
        preset: 'chat',
        r: 1,
        space: { ncmoe: [1] },
      });
      const sweep = yield* sweeps.create(sweepSpec);
      const spec = yield* specOf({ kind: 'bench', modelPath: model, r: 1 });
      const [queued] = yield* runs.enqueue(sweep.id, [{ spec, label: '-ncmoe 1', fit: 'fits' }]);
      if (queued !== undefined) yield* runs.finish(queued.id, { status: 'ok' });
      yield* sweeps.setStatus(sweep.id, 'done');
      const refused = yield* Effect.flip(runner.resume(sweep.id, { stopServer: true }));
      assert.strictEqual(refused._tag, 'NothingToResume');
      assert.strictEqual(refused.message, 'Nothing to resume: no interrupted or queued item');
      yield* gateWas([]);
      const busy = yield* runner.busy;
      assert.isFalse(busy);
      const state = yield* (yield* Supervisor).state;
      assert.strictEqual(state.kind, 'ready');
    }).pipe(withRunner(), fresh),
  );

  it.live('the end of a sweep shows restarting-server while llama-server comes back', () =>
    Effect.gen(function* () {
      yield* useFake({ FAKE_BENCH_STEP_MS: '5' });
      yield* startA;
      yield* startSweepOf([1]);
      yield* sweepEnded;
      const all = yield* published;
      const restarting = Arr.findLastIndex(
        all,
        (m) => m.type === 'bench-progress' && m.payload?.phase === 'restarting-server',
      );
      const cleared = Arr.findLastIndex(all, (m) => m.type === 'bench-progress' && m.payload === null);
      const ended = Arr.findLastIndex(all, (m) => m.type === 'sweep-progress' && m.payload === null);
      assert.isTrue(Option.isSome(restarting) && Option.isSome(cleared) && Option.isSome(ended));
      if (Option.isSome(restarting) && Option.isSome(cleared) && Option.isSome(ended)) {
        assert.isBelow(restarting.value, cleared.value);
        assert.isBelow(cleared.value, ended.value);
      }
      const lives = yield* progress;
      const shown = Arr.findLast(lives, (l) => l?.phase === 'restarting-server');
      assert.strictEqual(Option.getOrNull(shown)?.step, null);
      yield* stateWhen((s) => s.kind === 'ready');
    }).pipe(withRunner(), fresh),
  );

  it.live('cancelling an unknown run is a 404, a run that is not current a 409', () =>
    Effect.gen(function* () {
      const runner = yield* BenchRunner;
      yield* useFake();
      const unknown = yield* Effect.flip(runner.cancel(999));
      assert.strictEqual(unknown._tag, 'RunNotFound');
      assert.strictEqual(unknown.message, 'Run not found');
      const run = yield* startBench;
      yield* runEnded;
      const done = yield* Effect.flip(runner.cancel(run.id));
      assert.strictEqual(done._tag, 'RunNotRunning');
      assert.strictEqual(done.message, 'This run is not running');
    }).pipe(withRunner(), fresh),
  );

  it.effect('the sweep loop pauses between items', () =>
    Effect.gen(function* () {
      yield* useFake({ FAKE_BENCH_STEP_MS: '0' });
      const sweep = yield* startSweepOf([1, 2]);
      const statuses = Effect.map(
        itemsOf(sweep.id),
        Arr.map((r: BenchRun) => r.status),
      );
      // The first item ends, then the loop waits on the clock.
      yield* TestClock.withLive(until(Effect.map(statuses, (s) => s[0] === 'ok')));
      yield* TestClock.withLive(Effect.sleep('300 millis'));
      yield* Effect.map(statuses, (now) => assert.deepStrictEqual(now, ['ok', 'queued']));
      yield* TestClock.adjust('999 millis');
      yield* TestClock.withLive(Effect.sleep('300 millis'));
      yield* Effect.map(statuses, (now) => assert.deepStrictEqual(now, ['ok', 'queued']));
      yield* TestClock.adjust('1 millis');
      yield* TestClock.withLive(until(Effect.map(statuses, (s) => s[1] !== 'queued')));
    }).pipe(withRunner({ pause: '1 second' }), fresh),
  );

  it.effect('bench-progress is throttled to one message per 250 ms and carries the 20 last lines', () =>
    Effect.gen(function* () {
      const sent = yield* Ref.make<ReadonlyArray<number>>([]);
      const throttle = yield* makeThrottle('250 millis');
      const lines = Arr.makeBy(30, (i) => `line ${i}`);
      // What execute hands the runner: the live with its last 20 lines, flagged when only the lines changed.
      const send = (i: number, onlyLines: boolean) =>
        throttle(onlyLines, Ref.update(sent, Arr.append(Arr.takeRight(Arr.take(lines, i + 1), 20).length * 100 + i)));
      yield* send(0, false); // t = 0: a phase, sent
      yield* send(1, true); // t = 0: dropped
      yield* TestClock.adjust('100 millis');
      yield* send(2, true); // t = 100: dropped
      yield* TestClock.adjust('150 millis');
      yield* send(25, true); // t = 250: sent, its 20 last lines
      yield* TestClock.adjust('50 millis');
      yield* send(26, true); // t = 300: dropped
      yield* send(27, false); // t = 300: a step, sent
      yield* TestClock.adjust('200 millis');
      yield* send(28, true); // t = 500: dropped (250 ms after 300 is 550)
      yield* TestClock.adjust('50 millis');
      yield* send(29, true); // t = 550: sent
      const result = yield* Ref.get(sent);
      assert.deepStrictEqual(result, [100, 2025, 2027, 2029]);
    }),
  );

  it.live('the orphans of the last run are interrupted when the layer is built', () =>
    Effect.gen(function* () {
      const runs = yield* BenchRunsRepo;
      const sweeps = yield* SweepsRepo;
      const model = yield* Model;
      const spec = yield* specOf({ kind: 'bench', modelPath: model });
      const run = yield* runs.create({ spec, command: 'x', hardware: HARDWARE, status: 'running' });
      const sweepSpec = yield* sweepSpecOf({ name: 's', modelPath: model, preset: 'chat', space: { ncmoe: [1] } });
      const sweep = yield* sweeps.create(sweepSpec);
      assert.strictEqual(sweep.status, 'running');
      const built = Effect.gen(function* () {
        const after = yield* Effect.flatMap(runs.get(run.id), Effect.fromOption).pipe(Effect.orDie);
        assert.strictEqual(after.status, 'interrupted');
        assert.strictEqual(after.error, 'interrupted (llama-webui stopped)');
        const swept = yield* sweepOfId(sweep.id);
        assert.strictEqual(swept.status, 'interrupted');
      });
      yield* withRunner()(built);
    }).pipe(fresh),
  );

  it.live('busy covers the claim, the run, the sweep and the gate', () =>
    Effect.gen(function* () {
      const runner = yield* BenchRunner;
      const sweeps = yield* SweepsRepo;
      const model = yield* Model;
      yield* useFake({ FAKE_BENCH_STEP_MS: '100' });
      const idle = yield* runner.busy;
      assert.isFalse(idle);
      // The claim: a sweep request held in its check, before the gate.
      const checked = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const request = yield* Effect.forkChild(
        runner.startSweep({
          files: { modelPath: model, mmprojPath: null },
          stopServer: true,
          check: Deferred.succeed(checked, undefined).pipe(Effect.andThen(Deferred.await(release))),
          prepare: Effect.die('not reached'),
        }),
      );
      yield* Deferred.await(checked);
      const claimed = yield* runner.busy;
      assert.isTrue(claimed);
      yield* Fiber.interrupt(request);
      const unclaimed = yield* runner.busy;
      assert.isFalse(unclaimed);
      // The run.
      yield* startBench;
      const running = yield* runner.busy;
      assert.isTrue(running);
      yield* runEnded;
      const ran = yield* runner.busy;
      assert.isFalse(ran);
      // The sweep, between its items too.
      yield* startSweepOf([1, 2]);
      const sweeping = yield* runner.busy;
      assert.isTrue(sweeping);
      yield* sweepEnded;
      const swept = yield* runner.busy;
      assert.isFalse(swept);
      // The gate, held by a sweep request until its rows are written.
      const prepared = yield* Deferred.make<void>();
      const writing = yield* Effect.forkChild(
        runner.startSweep({
          files: { modelPath: model, mmprojPath: null },
          stopServer: true,
          prepare: Deferred.succeed(prepared, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.andThen(sweeps.list.pipe(Effect.as(0))),
          ),
        }),
      );
      yield* Deferred.await(prepared);
      const gated = yield* runner.busy;
      assert.isTrue(gated);
      yield* Fiber.interrupt(writing);
      const freed = yield* runner.busy;
      assert.isFalse(freed);
    }).pipe(withRunner(), fresh),
  );

  it.live('a missing projector is refused like a missing model by a run, a resume and a validation', () =>
    Effect.gen(function* () {
      const runner = yield* BenchRunner;
      const runs = yield* BenchRunsRepo;
      const sweeps = yield* SweepsRepo;
      const model = yield* Model;
      yield* useFake();
      yield* startA;
      const missing = 'Projector not found: /nulle/mmproj.gguf';
      const spec = yield* specOf({ kind: 'bench', modelPath: model, mmprojPath: '/nulle/mmproj.gguf', r: 1 });
      const run = yield* Effect.flip(runner.start(spec, { stopServer: true }));
      assert.deepStrictEqual([run._tag, run.message], ['BenchFileMissing', missing]);
      const sweepSpec = yield* sweepSpecOf({
        name: 's',
        modelPath: model,
        mmprojPath: '/nulle/mmproj.gguf',
        preset: 'chat',
        r: 1,
        space: { ncmoe: [1, 2] },
      });
      const sweep = yield* sweeps.create(sweepSpec);
      const [first] = yield* runs.enqueue(sweep.id, [
        { spec, label: '-ncmoe 1', fit: 'fits' },
        { spec, label: '-ncmoe 2', fit: 'fits' },
      ]);
      const measured = { tps: 100, stddev: 0, tokens: 10 };
      if (first !== undefined) yield* runs.finish(first.id, { status: 'ok', pp: measured, tg: measured });
      yield* sweeps.setStatus(sweep.id, 'interrupted');
      const resumed = yield* Effect.flip(runner.resume(sweep.id, { stopServer: true }));
      assert.deepStrictEqual([resumed._tag, resumed.message], ['BenchFileMissing', missing]);
      const validated = yield* Effect.flip(runner.validate(sweep.id, { n: 1, stopServer: true }));
      assert.deepStrictEqual([validated._tag, validated.message], ['BenchFileMissing', missing]);
      yield* gateWas([]);
      const state = yield* (yield* Supervisor).state;
      assert.strictEqual(state.kind, 'ready');
    }).pipe(withRunner(), fresh),
  );

  it.live('validating a sweep without a successful run is a 409 and stops nothing', () =>
    Effect.gen(function* () {
      const runner = yield* BenchRunner;
      const runs = yield* BenchRunsRepo;
      const sweeps = yield* SweepsRepo;
      const model = yield* Model;
      yield* useFake();
      yield* startA;
      const sweepSpec = yield* sweepSpecOf({
        name: 's',
        modelPath: model,
        preset: 'chat',
        r: 1,
        space: { ncmoe: [1] },
      });
      const sweep = yield* sweeps.create(sweepSpec);
      const spec = yield* specOf({ kind: 'bench', modelPath: model, r: 1 });
      const [item] = yield* runs.enqueue(sweep.id, [{ spec, label: '-ncmoe 1', fit: 'fits' }]);
      if (item !== undefined) yield* runs.finish(item.id, { status: 'failed', error: 'Out of memory' });
      yield* sweeps.setStatus(sweep.id, 'done');
      const refused = yield* Effect.flip(runner.validate(sweep.id, { n: 3, stopServer: true }));
      assert.deepStrictEqual([refused._tag, refused.message], ['NothingToValidate', 'No successful run to validate']);
      yield* gateWas([]);
      const busy = yield* runner.busy;
      assert.isFalse(busy);
    }).pipe(withRunner(), fresh),
  );

  it.live('resuming an interrupted sweep runs its interrupted and queued items and ends it done', () =>
    Effect.gen(function* () {
      const runner = yield* BenchRunner;
      const runs = yield* BenchRunsRepo;
      const sweeps = yield* SweepsRepo;
      yield* useFake({ FAKE_BENCH_STEP_MS: '5' });
      const sweep = yield* startSweepOf([1, 2, 3]);
      yield* sweepEnded;
      // As after a Ctrl-C during item 2: item 2 interrupted, item 3 still queued.
      const explored = yield* itemsOf(sweep.id);
      const [, second, third] = explored;
      if (second === undefined || third === undefined) return assert.fail('three items expected');
      yield* runs.finish(second.id, { status: 'interrupted', error: 'interrupted (llama-webui stopped)' });
      yield* runs.requeue(third.id);
      yield* sweeps.setStatus(sweep.id, 'interrupted');
      const before = (yield* sweepProgress).length;
      const resumed = yield* runner.resume(sweep.id, { stopServer: true });
      assert.strictEqual(resumed.status, 'running');
      yield* until(
        Effect.map(
          sweepProgress,
          (lives) => lives.length > before + 1 && Arr.last(lives).pipe(Option.exists((l) => l === null)),
        ),
      );
      const items = yield* itemsOf(sweep.id);
      assert.deepStrictEqual(
        Arr.map(items, (r) => r.status),
        ['ok', 'ok', 'ok'],
      );
      const final = yield* sweepOfId(sweep.id);
      assert.strictEqual(final.status, 'done');
      assert.isNotNull(final.finishedAt);
    }).pipe(withRunner(), fresh),
  );
});
