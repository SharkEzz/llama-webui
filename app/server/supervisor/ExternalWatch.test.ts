import { NodeServices } from '@effect/platform-node';
import { assert, layer } from '@effect/vitest';
import { DEFAULT_SETTINGS, type Profile, type ServerState } from '@llama-webui/shared';
import { Context, Effect, Exit, Fiber, FileSystem, Layer, Ref, Schedule, Scope } from 'effect';
import { BenchRunner } from '../bench/BenchRunner.ts';
import * as Db from '../db/Db.ts';
import { LlamaHttp } from '../llama/LlamaHttp.ts';
import { LogRing } from '../logs/LogRing.ts';
import { SettingsRepo } from '../settings/SettingsRepo.ts';
import { FAKE, fakeOutside, freePort, httpStub, pidAlive } from '../testing/llama.ts';
import { WsHub } from '../ws/WsHub.ts';
import { buildCommand } from './command.ts';
import { ExternalWatch } from './ExternalWatch.ts';
import { Supervisor } from './Supervisor.ts';

/** A hub with no client. */
const SilentHub = Layer.succeed(WsHub, {
  publish: Effect.fn(() => Effect.void),
  size: Effect.succeed(0),
  attach: Effect.fn(() => Effect.void),
});

/** How the bench runner answers `busy`, as the test sets it. */
class Busy extends Context.Service<Busy, Ref.Ref<Effect.Effect<boolean>>>()(
  '@llama-webui/app/server/supervisor/ExternalWatch.test/Busy',
) {}

/** A bench runner that only answers `busy`, from `Busy`. */
const BusyRunner = Layer.effect(
  BenchRunner,
  Effect.gen(function* () {
    const busy = yield* Busy;
    const unused = Effect.die('not used by the watch');
    return BenchRunner.of({
      busy: busy.pipe(Ref.get, Effect.flatten),
      live: unused,
      sweepLive: unused,
      files: unused,
      start: () => unused,
      startSweep: () => unused,
      resume: () => unused,
      validate: () => unused,
      cancel: () => unused,
      cancelSweep: () => unused,
    });
  }),
).pipe(Layer.provideMerge(Layer.effect(Busy, Ref.make(Effect.succeed(false)))));

/** The supervisor (pids read from `procRoot`), the settings on a new database and a bench runner of `Busy`. */
const servicesWith = (procRoot: string) =>
  Supervisor.layerWith({ killTimeout: '300 millis', healthPoll: '50 millis', procRoot }).pipe(
    Layer.provideMerge(BusyRunner),
    Layer.provideMerge(Layer.mergeAll(LogRing.layer, LlamaHttp.layer, SettingsRepo.layer)),
    Layer.provideMerge(SilentHub),
    Layer.provideMerge(Db.layerAt(':memory:')),
    Layer.provideMerge(NodeServices.layer),
  );

/** The watch, every 100 ms, on the services of the test: it stops with the test. */
const watching = Layer.build(ExternalWatch.layerWith({ interval: '100 millis' }));

/** A folder made like `/proc`, naming `pid` as a `llama-server` on `port`. */
const procNaming = Effect.fnUntraced(function* (pid: number, port: number) {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: 'lw-proc-' });
  yield* fs.makeDirectory(`${root}/${pid}`);
  yield* fs.writeFileString(`${root}/${pid}/cmdline`, `llama-server\0--port\0${port}\0`);
  return root;
});

/** The state, once `ok` holds (looked at every 10 ms, for 5 s at most). */
const stateWhen = Effect.fnUntraced(function* (ok: (state: ServerState) => boolean) {
  const supervisor = yield* Supervisor;
  return yield* supervisor.state.pipe(
    Effect.repeat({ schedule: Schedule.spaced('10 millis'), until: ok }),
    Effect.timeout('5 seconds'),
  );
});

/** The `port` setting set to `port`. */
const portSetting = Effect.fnUntraced(function* (port: number) {
  const settings = yield* SettingsRepo;
  yield* settings.patch({ port });
});

/** Starts the fake on `port` under the supervisor, its `env` holding the `FAKE_*` variables. */
const startFake = Effect.fnUntraced(function* (port: number, env: Readonly<Record<string, string>> = {}) {
  const supervisor = yield* Supervisor;
  const profile: Profile = {
    id: 1,
    name: 'fake',
    model: 'm.gguf',
    args: [],
    env: { ...env },
    port,
    source: 'ui',
    createdAt: 0,
    updatedAt: 0,
  };
  const cmd = yield* buildCommand({ profile, settings: { ...DEFAULT_SETTINGS, binary: FAKE } });
  yield* supervisor.start(cmd);
});

layer(NodeServices.layer, { excludeTestServices: true })('ExternalWatch', (it) => {
  it.effect('a llama-server on the settings port is detected at the start, then gone once it stops', () =>
    Effect.gen(function* () {
      const port = yield* freePort;
      const outside = yield* Scope.make();
      const fake = yield* fakeOutside({ port }).pipe(Scope.provide(outside));
      const procRoot = yield* procNaming(fake.pid, port);
      const services = yield* Layer.build(servicesWith(procRoot));
      yield* Effect.gen(function* () {
        yield* portSetting(port);
        yield* watching;
        const external = yield* stateWhen((state) => state.kind === 'external').pipe(Effect.timeout('1 second'));
        assert.deepStrictEqual(external, { kind: 'external', pid: fake.pid, port });
        yield* Scope.close(outside, Exit.void);
        assert.isFalse(pidAlive(fake.pid));
        yield* stateWhen((state) => state.kind === 'idle');
      }).pipe(Effect.provideContext(services));
    }),
  );

  it.effect('after a crash, the settings port and the last profile port are watched (#39, #28)', () =>
    Effect.gen(function* () {
      const [settingsPort, profilePort] = yield* Effect.all([freePort, freePort]);
      const procRoot = yield* procNaming(process.pid, profilePort);
      const outside = yield* Scope.make();
      const services = yield* Layer.build(servicesWith(procRoot));
      let fakePid = 0;
      yield* Effect.gen(function* () {
        yield* portSetting(settingsPort);
        yield* watching;
        yield* startFake(profilePort, { FAKE_EXIT_AFTER_MS: '100', FAKE_EXIT_CODE: '1' });
        yield* stateWhen((state) => state.kind === 'crashed');
        const fake = yield* fakeOutside({ port: profilePort }).pipe(Scope.provide(outside));
        fakePid = fake.pid;
        const external = yield* stateWhen((state) => state.kind === 'external');
        assert.deepStrictEqual(external, { kind: 'external', pid: process.pid, port: profilePort });
      }).pipe(Effect.provideContext(services));
      yield* Scope.close(outside, Exit.void);
      assert.isFalse(pidAlive(fakePid));
    }),
  );

  it.effect('nothing is probed while a server is starting, ready or stopping', () =>
    Effect.gen(function* () {
      const stub = yield* httpStub((_req, res) => {
        res.writeHead(404).end();
      });
      const fakePort = yield* freePort;
      const procRoot = yield* procNaming(process.pid, stub.port);
      const services = yield* Layer.build(servicesWith(procRoot));
      yield* Effect.gen(function* () {
        const supervisor = yield* Supervisor;
        yield* portSetting(stub.port);
        // Started before the watch, which would otherwise look at the settings port once while idle.
        yield* startFake(fakePort, { FAKE_IGNORE_TERM: '1' });
        yield* watching;
        const ready = yield* stateWhen((state) => state.kind === 'ready');
        const pid = ready.kind === 'ready' ? ready.pid : 0;
        // Three looks of the watch at least.
        yield* Effect.sleep('350 millis');
        const stopping = yield* Effect.forkChild(supervisor.stop);
        yield* stateWhen((state) => state.kind === 'stopping');
        yield* Effect.sleep('200 millis');
        const requests = stub.requests();
        yield* Fiber.join(stopping);
        assert.strictEqual(requests, 0);
        assert.isFalse(pidAlive(pid));
      }).pipe(Effect.provideContext(services));
    }),
  );

  it.effect('no external server is detected while a benchmark owns the port', () =>
    Effect.gen(function* () {
      const port = yield* freePort;
      const outside = yield* Scope.make();
      const fake = yield* fakeOutside({ port }).pipe(Scope.provide(outside));
      const procRoot = yield* procNaming(fake.pid, port);
      const services = yield* Layer.build(servicesWith(procRoot));
      yield* Effect.gen(function* () {
        const supervisor = yield* Supervisor;
        const busy = yield* Busy;
        yield* Ref.set(busy, Effect.succeed(true));
        yield* portSetting(port);
        yield* watching;
        // Three looks of the watch at least.
        yield* Effect.sleep('350 millis');
        const meanwhile = yield* supervisor.state;
        assert.strictEqual(meanwhile.kind, 'idle');
        yield* Ref.set(busy, Effect.succeed(false));
        const external = yield* stateWhen((state) => state.kind === 'external');
        assert.deepStrictEqual(external, { kind: 'external', pid: fake.pid, port });
      }).pipe(Effect.provideContext(services));
      yield* Scope.close(outside, Exit.void);
      assert.isFalse(pidAlive(fake.pid));
    }),
  );

  it.effect('a look that dies on a defect does not end the watch', () =>
    Effect.gen(function* () {
      const port = yield* freePort;
      const outside = yield* Scope.make();
      const fake = yield* fakeOutside({ port }).pipe(Scope.provide(outside));
      const procRoot = yield* procNaming(fake.pid, port);
      const services = yield* Layer.build(servicesWith(procRoot));
      yield* Effect.gen(function* () {
        const busy = yield* Busy;
        yield* Ref.set(busy, Effect.die(new Error('database is locked')));
        yield* portSetting(port);
        yield* watching;
        // Two looks of the watch at least, each one dying.
        yield* Effect.sleep('250 millis');
        yield* Ref.set(busy, Effect.succeed(false));
        const external = yield* stateWhen((state) => state.kind === 'external');
        assert.deepStrictEqual(external, { kind: 'external', pid: fake.pid, port });
      }).pipe(Effect.provideContext(services));
      yield* Scope.close(outside, Exit.void);
      assert.isFalse(pidAlive(fake.pid));
    }),
  );
});
