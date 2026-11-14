import { NodeServices } from '@effect/platform-node';
import { assert, layer } from '@effect/vitest';
import { DEFAULT_SETTINGS, type Profile, type ServerState } from '@llama-webui/shared';
import { Effect, Exit, Fiber, FileSystem, Layer, Schedule, Scope } from 'effect';
import * as Db from '../db/Db.ts';
import { LlamaHttp } from '../llama/LlamaHttp.ts';
import { LogRing } from '../logs/LogRing.ts';
import { SettingsRepo } from '../settings/SettingsRepo.ts';
import { FAKE, fakeOutside, freePort, httpStub } from '../testing/llama.ts';
import { WsHub } from '../ws/WsHub.ts';
import { buildCommand } from './command.ts';
import { ExternalWatch } from './ExternalWatch.ts';
import { Supervisor } from './Supervisor.ts';

/** A hub with no client. */
const SilentHub = Layer.succeed(WsHub, {
  publish: () => Effect.void,
  size: Effect.succeed(0),
  attach: () => Effect.void,
});

/** The supervisor (pids read from `procRoot`) and the settings on a new database. */
const servicesWith = (procRoot: string) =>
  Supervisor.layerWith({ killTimeout: '300 millis', healthPoll: '50 millis', procRoot }).pipe(
    Layer.provideMerge(Layer.mergeAll(LogRing.layer, LlamaHttp.layer, SettingsRepo.layer)),
    Layer.provideMerge(SilentHub),
    Layer.provideMerge(Db.layerAt(':memory:')),
    Layer.provideMerge(NodeServices.layer),
  );

/** The watch, every 100 ms, on the services of the test: it stops with the test. */
const watching = Layer.build(ExternalWatch.layerWith({ interval: '100 millis' }));

/** A folder made like `/proc`, naming `pid` as a `llama-server` on `port`. */
const procNaming = (pid: number, port: number) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: 'lw-proc-' });
    yield* fs.makeDirectory(`${root}/${pid}`);
    yield* fs.writeFileString(`${root}/${pid}/cmdline`, `llama-server\0--port\0${port}\0`);
    return root;
  });

/** The state, once `ok` holds (looked at every 10 ms, for 5 s at most). */
const stateWhen = (ok: (state: ServerState) => boolean) =>
  Effect.gen(function* () {
    const supervisor = yield* Supervisor;
    return yield* supervisor.state.pipe(
      Effect.repeat({ schedule: Schedule.spaced('10 millis'), until: ok }),
      Effect.timeout('5 seconds'),
    );
  });

/** The `port` setting set to `port`. */
const portSetting = (port: number) =>
  Effect.gen(function* () {
    const settings = yield* SettingsRepo;
    yield* settings.patch({ port });
  });

/** Starts the fake on `port` under the supervisor, its `env` holding the `FAKE_*` variables. */
const startFake = (port: number, env: Readonly<Record<string, string>> = {}) =>
  Effect.gen(function* () {
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
        yield* stateWhen((state) => state.kind === 'idle');
      }).pipe(Effect.provideContext(services));
    }),
  );

  it.effect('after a crash, the settings port and the last profile port are watched (#39, #28)', () =>
    Effect.gen(function* () {
      const [settingsPort, profilePort] = yield* Effect.all([freePort, freePort]);
      const procRoot = yield* procNaming(process.pid, profilePort);
      const services = yield* Layer.build(servicesWith(procRoot));
      yield* Effect.gen(function* () {
        yield* portSetting(settingsPort);
        yield* watching;
        yield* startFake(profilePort, { FAKE_EXIT_AFTER_MS: '100', FAKE_EXIT_CODE: '1' });
        yield* stateWhen((state) => state.kind === 'crashed');
        yield* fakeOutside({ port: profilePort });
        const external = yield* stateWhen((state) => state.kind === 'external');
        assert.deepStrictEqual(external, { kind: 'external', pid: process.pid, port: profilePort });
      }).pipe(Effect.provideContext(services));
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
        yield* stateWhen((state) => state.kind === 'ready');
        // Three looks of the watch at least.
        yield* Effect.sleep('350 millis');
        const stopping = yield* Effect.forkChild(supervisor.stop);
        yield* stateWhen((state) => state.kind === 'stopping');
        yield* Effect.sleep('200 millis');
        const requests = stub.requests();
        yield* Fiber.join(stopping);
        assert.strictEqual(requests, 0);
      }).pipe(Effect.provideContext(services));
    }),
  );
});
