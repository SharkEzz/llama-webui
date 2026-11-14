import { NodeServices } from '@effect/platform-node';
import { assert, layer } from '@effect/vitest';
import { DEFAULT_SETTINGS, type Profile, type ServerState, type ServerView, type WsMessage } from '@llama-webui/shared';
import {
  Array as Arr,
  Clock,
  Context,
  type Duration,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Option,
  type Path,
  Ref,
  Schedule,
  Scope,
  String as Str,
} from 'effect';
import type { ChildProcessSpawner } from 'effect/process';
import { LlamaHttp } from '../llama/LlamaHttp.ts';
import { isAlive } from '../llama/procScan.ts';
import { LogRing } from '../logs/LogRing.ts';
import { FAKE, fakeOutside, freePort, httpStub, killFromOutside, ownVariable } from '../testing/llama.ts';
import { WsHub } from '../ws/WsHub.ts';
import { type BuiltCommand, buildCommand } from './command.ts';
import { Supervisor } from './Supervisor.ts';

/** What the hub of the test was given to publish, in order. */
class Published extends Context.Service<Published, Ref.Ref<ReadonlyArray<WsMessage>>>()(
  '@llama-webui/app/server/supervisor/Supervisor.test/Published',
) {}

/** A hub that records what is published. */
const RecordingHub = Layer.effect(
  WsHub,
  Effect.gen(function* () {
    const published = yield* Published;
    return {
      publish: (message: WsMessage) => Ref.update(published, Arr.append(message)),
      size: Effect.succeed(0),
      attach: () => Effect.void,
    };
  }),
);

interface Options {
  readonly killTimeout?: Duration.Input;
  readonly procRoot?: string;
}

/** The supervisor with a short poll, on a ring, the client, a recording hub and the Node platform. */
const supervisorWith = (options: Options) =>
  Supervisor.layerWith({ killTimeout: '2 seconds', healthPoll: '50 millis', ...options }).pipe(
    Layer.provideMerge(Layer.mergeAll(LogRing.layer, LlamaHttp.layer)),
    Layer.provideMerge(RecordingHub),
    Layer.provideMerge(Layer.effect(Published, Ref.make<ReadonlyArray<WsMessage>>([]))),
    Layer.provideMerge(NodeServices.layer),
  );

type Services =
  | Supervisor
  | LogRing
  | Published
  | FileSystem.FileSystem
  | Path.Path
  | ChildProcessSpawner.ChildProcessSpawner
  | Scope.Scope;

/** `test` on a supervisor of its own, whose layer ends (its server stopped) when the test ends. */
const fresh =
  (options: Options = {}) =>
  <A, E>(test: Effect.Effect<A, E, Services>) =>
    Layer.build(supervisorWith(options)).pipe(
      Effect.flatMap((context) => Effect.provideContext(test, context)),
      Effect.scoped,
    );

let nextId = 1;

interface Launch {
  readonly env?: Readonly<Record<string, string>>;
  readonly settingsEnv?: Readonly<Record<string, string>>;
  readonly host?: string;
  readonly cwd?: string;
  readonly port?: number;
  readonly name?: string;
}

/** The command of a profile that runs the fake on a free port, its `env` holding the `FAKE_*` variables. */
const launchOf = (options: Launch = {}) =>
  Effect.gen(function* () {
    const port = options.port ?? (yield* freePort);
    const profile: Profile = {
      id: nextId++,
      name: options.name ?? 'fake',
      model: 'm.gguf',
      args: [],
      env: { ...options.env },
      port,
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      source: 'ui',
      createdAt: 0,
      updatedAt: 0,
    };
    const settings = {
      ...DEFAULT_SETTINGS,
      binary: FAKE,
      host: options.host ?? '127.0.0.1',
      env: { ...options.settingsEnv },
    };
    return yield* buildCommand({ profile, settings });
  });

/** Starts the fake of `options`: its command. */
const startFake = (options: Launch = {}) =>
  Effect.gen(function* () {
    const supervisor = yield* Supervisor;
    const cmd = yield* launchOf(options);
    yield* supervisor.start(cmd);
    return cmd;
  });

/** The start of the fake of `options` fails: its error. */
const refusedStart = (options: Launch = {}) =>
  Effect.gen(function* () {
    const supervisor = yield* Supervisor;
    const cmd = yield* launchOf(options);
    return yield* Effect.flip(supervisor.start(cmd));
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

const kindIs =
  (...kinds: ReadonlyArray<ServerState['kind']>) =>
  (state: ServerState) =>
    Arr.contains(kinds, state.kind);

/** The pid a state names, -1 when it names none. */
const pidOf = (state: ServerState): number => ('pid' in state && state.pid !== null ? state.pid : -1);

/** The profile a state names, if any. */
const profileOf = (state: ServerState): string | null => ('profile' in state ? state.profile : null);

/** The state now, which must include `expected`. */
const assertState = (expected: Readonly<Record<string, unknown>>) =>
  Effect.gen(function* () {
    const supervisor = yield* Supervisor;
    const state = yield* supervisor.state;
    assert.deepInclude(state, expected);
    return state;
  });

const assertAlive = (pid: number) => Effect.map(isAlive(pid), (alive) => assert.isTrue(pid > 0 && alive, `${pid}`));

const assertGone = (pid: number) => Effect.map(isAlive(pid), (alive) => assert.isTrue(pid > 0 && !alive, `${pid}`));

const ringTexts = Effect.gen(function* () {
  const ring = yield* LogRing;
  const lines = yield* ring.since(0);
  return Arr.map(lines, (line) => line.text);
});

/** The texts of the ring, once `ok` holds of them. */
const ringWhen = (ok: (texts: ReadonlyArray<string>) => boolean) =>
  ringTexts.pipe(Effect.repeat({ schedule: Schedule.spaced('10 millis'), until: ok }), Effect.timeout('5 seconds'));

const lastIs = (text: string) => (texts: ReadonlyArray<string>) =>
  Option.exists(Arr.last(texts), (last) => last === text);

/** The fake's prefix of a line taken off. */
const withoutPrefix = Str.replace(/^0\.00\.000\.000 I /, '');

/** The views published as `server-state`, in order. */
const publishedViews = Effect.gen(function* () {
  const published = yield* Published;
  const messages = yield* Ref.get(published);
  return Arr.flatMap(
    messages,
    (message): ReadonlyArray<ServerView> => (message.type === 'server-state' ? [message.payload] : []),
  );
});

const publishedKinds = Effect.map(
  publishedViews,
  Arr.map((view: ServerView) => view.state.kind),
);

/** A folder made like `/proc`, naming `pid` as a `llama-server` on `port`. */
const procNaming = (pid: number, port: number) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: 'lw-proc-' });
    yield* fs.makeDirectory(`${root}/${pid}`);
    yield* fs.writeFileString(`${root}/${pid}/cmdline`, `llama-server\0--port\0${port}\0`);
    return root;
  });

/** `cmd` with its binary replaced by one that does not exist. */
const withMissingBinary = (cmd: BuiltCommand): BuiltCommand => ({
  ...cmd,
  argv: Arr.map(cmd.argv, (arg) => (arg === FAKE ? '/no/such/llama-server' : arg)),
});

layer(NodeServices.layer, { excludeTestServices: true })('Supervisor', (it) => {
  it.effect('start: starting with the pid, then ready once /health answers 200', () =>
    fresh()(
      Effect.gen(function* () {
        const before = yield* Clock.currentTimeMillis;
        const cmd = yield* startFake();
        const starting = yield* assertState({ kind: 'starting' });
        yield* assertAlive(pidOf(starting));
        const ready = yield* stateWhen(kindIs('ready'));
        assert.deepInclude(ready, {
          kind: 'ready',
          pid: pidOf(starting),
          profile: 'fake',
          profileId: cmd.profileId,
          host: '127.0.0.1',
          port: cmd.port,
        });
        if (ready.kind === 'ready' && starting.kind === 'starting') {
          assert.isAtLeast(starting.since, before);
          assert.isAbove(ready.since, starting.since);
        }
      }),
    ),
  );

  it.effect('the ring holds the launch line, then what llama-server wrote, without the idle noise', () =>
    fresh()(
      Effect.gen(function* () {
        const cmd = yield* startFake({
          env: { FAKE_EXIT_LINES: 'srv  update_slots: all slots are idle|srv  main: after the noise' },
        });
        const texts = yield* ringWhen(lastIs('[llama-webui] llama-server exited (code 1)'));
        assert.deepStrictEqual(Arr.map(texts, withoutPrefix), [
          `[llama-webui] launch: ${cmd.display}`,
          'srv  main: loading model',
          `srv  main: cwd ${cmd.cwd}`,
          'srv  main: after the noise',
          '[llama-webui] llama-server exited (code 1)',
        ]);
      }),
    ),
  );

  it.effect(
    "cwd and the environment reach llama-server: the settings variables, the profile ones over them, llama-webui's own under both",
    () =>
      fresh()(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const cwd = yield* fs.makeTempDirectoryScoped({ prefix: 'lw-cwd-' });
          yield* ownVariable('LW_OWN', 'own');
          yield* ownVariable('LW_A', 'own');
          yield* startFake({
            cwd,
            settingsEnv: { LW_A: 'settings', LW_B: 'settings' },
            env: { LW_B: 'profile', FAKE_ECHO_ENV: 'LW_OWN,LW_A,LW_B' },
          });
          const texts = yield* ringWhen(Arr.some(Str.endsWith('env LW_B=profile')));
          assert.includeMembers(Arr.map(texts, withoutPrefix), [
            `srv  main: cwd ${cwd}`,
            'srv  main: env LW_OWN=own',
            'srv  main: env LW_A=settings',
            'srv  main: env LW_B=profile',
          ]);
        }),
      ),
  );

  it.effect('stop: stopping, then idle; the ring ends with "llama-server exited (code 0)"; the process is gone', () =>
    fresh()(
      Effect.gen(function* () {
        const supervisor = yield* Supervisor;
        yield* startFake();
        const ready = yield* stateWhen(kindIs('ready'));
        yield* supervisor.stop;
        const kinds = yield* publishedKinds;
        assert.deepStrictEqual(Arr.takeRight(kinds, 2), ['stopping', 'idle']);
        yield* assertState({ kind: 'idle' });
        const texts = yield* ringTexts;
        assert.deepStrictEqual(Arr.last(texts), Option.some('[llama-webui] llama-server exited (code 0)'));
        yield* assertGone(pidOf(ready));
      }),
    ),
  );

  it.effect(
    'a server that ignores SIGTERM is killed after the timeout: the ring says so, then "(code -, SIGKILL)"',
    () =>
      fresh({ killTimeout: '300 millis' })(
        Effect.gen(function* () {
          const supervisor = yield* Supervisor;
          yield* startFake({ env: { FAKE_IGNORE_TERM: '1' } });
          const ready = yield* stateWhen(kindIs('ready'));
          yield* supervisor.stop;
          const texts = yield* ringTexts;
          assert.deepStrictEqual(Arr.takeRight(texts, 2), [
            '[llama-webui] not stopped after 300 ms, SIGKILL',
            '[llama-webui] llama-server exited (code -, SIGKILL)',
          ]);
          assert.include(Arr.map(texts, withoutPrefix), 'srv  main: ignoring SIGTERM');
          yield* assertState({ kind: 'idle' });
          yield* assertGone(pidOf(ready));
        }),
      ),
  );

  it.effect('stop returns as soon as llama-server exited, long before the kill timeout', () =>
    fresh({ killTimeout: '30 seconds' })(
      Effect.gen(function* () {
        const supervisor = yield* Supervisor;
        yield* startFake();
        yield* stateWhen(kindIs('ready'));
        const before = yield* Clock.currentTimeMillis;
        yield* supervisor.stop;
        const after = yield* Clock.currentTimeMillis;
        assert.isBelow(after - before, 2000);
        yield* assertState({ kind: 'idle' });
      }),
    ),
  );

  it.effect('a stop while starting ends idle and never turns ready', () =>
    fresh()(
      Effect.gen(function* () {
        const supervisor = yield* Supervisor;
        yield* startFake({ env: { FAKE_LOAD_MS: '2000' } });
        const starting = yield* supervisor.state;
        yield* supervisor.stop;
        yield* Effect.sleep('500 millis');
        const kinds = yield* publishedKinds;
        assert.deepStrictEqual(kinds, ['starting', 'stopping', 'idle']);
        yield* assertGone(pidOf(starting));
      }),
    ),
  );

  it.effect('a crash: crashed with the exit code; killed from outside: crashed with the signal and no code', () =>
    fresh()(
      Effect.gen(function* () {
        const crashing = yield* startFake({ env: { FAKE_EXIT_AFTER_MS: '100', FAKE_EXIT_CODE: '3' } });
        const crashed = yield* stateWhen(kindIs('crashed'));
        assert.deepInclude(crashed, { kind: 'crashed', profileId: crashing.profileId, exitCode: 3, signal: null });
        yield* ringWhen(lastIs('[llama-webui] llama-server exited (code 3)'));

        yield* startFake();
        const ready = yield* stateWhen(kindIs('ready'));
        yield* killFromOutside(pidOf(ready));
        const killed = yield* stateWhen(kindIs('crashed'));
        assert.deepInclude(killed, { kind: 'crashed', exitCode: null, signal: 'SIGKILL' });
        const texts = yield* ringTexts;
        assert.deepStrictEqual(Arr.last(texts), Option.some('[llama-webui] llama-server exited (code -, SIGKILL)'));
      }),
    ),
  );

  it.effect('a server that dies at once leaves every line it wrote in the ring, the last one included', () =>
    fresh()(
      Effect.gen(function* () {
        yield* startFake({ env: { FAKE_FAIL_ARG: '--metrics', FAKE_TAIL: 'the last words, unterminated' } });
        const crashed = yield* stateWhen(kindIs('crashed'));
        assert.deepInclude(crashed, { exitCode: 1, signal: null });
        const texts = yield* ringTexts;
        assert.deepStrictEqual(Arr.takeRight(texts, 3), [
          '0.00.000.000 I ggml_cuda: out of memory',
          'the last words, unterminated',
          '[llama-webui] llama-server exited (code 1)',
        ]);

        // A binary that does not exist: setpriv says so and exits 127.
        const supervisor = yield* Supervisor;
        const cmd = yield* launchOf();
        yield* supervisor.start(withMissingBinary(cmd));
        const missing = yield* stateWhen((state) => state.kind === 'crashed' && state.exitCode === 127);
        assert.deepInclude(missing, { exitCode: 127, signal: null });
        const after = yield* ringTexts;
        assert.deepStrictEqual(Arr.last(after), Option.some('[llama-webui] llama-server exited (code 127)'));
        assert.isTrue(Arr.some(after, Str.startsWith('setpriv:')), Arr.join(after, '\n'));
      }),
    ),
  );

  it.effect(
    'a launch in a folder that does not exist is crashed with "directory not found: <cwd>", the ring line, and the command is remembered',
    () =>
      fresh()(
        Effect.gen(function* () {
          const supervisor = yield* Supervisor;
          const cmd = yield* startFake({ cwd: '/no/such/folder' });
          yield* assertState({
            kind: 'crashed',
            exitCode: null,
            signal: null,
            message: 'directory not found: /no/such/folder',
          });
          const texts = yield* ringTexts;
          assert.deepStrictEqual(
            Arr.last(texts),
            Option.some('[llama-webui] launch failed: directory not found: /no/such/folder'),
          );
          const last = yield* supervisor.lastCommand;
          assert.deepStrictEqual(last, Option.some(cmd));
          const view = yield* supervisor.view;
          assert.deepInclude(view, { command: cmd.display, profileId: cmd.profileId });
        }),
      ),
  );

  it.effect('a launch that cannot spawn is crashed with the cause', () =>
    fresh()(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const empty = yield* fs.makeTempDirectoryScoped({ prefix: 'lw-path-' });
        yield* startFake({ env: { PATH: empty } });
        const state = yield* assertState({ kind: 'crashed', exitCode: null, signal: null });
        const message = state.kind === 'crashed' ? (state.message ?? '') : '';
        assert.isTrue(Str.startsWith('spawn setpriv')(message), message);
        const texts = yield* ringTexts;
        assert.deepStrictEqual(Arr.last(texts), Option.some(`[llama-webui] launch failed: ${message}`));
      }),
    ),
  );

  it.effect('a start while another operation runs is OperationInProgress; once it ended, ServerAlreadyRunning', () =>
    fresh({ killTimeout: '300 millis' })(
      Effect.gen(function* () {
        const supervisor = yield* Supervisor;
        yield* startFake({ env: { FAKE_IGNORE_TERM: '1' } });
        yield* stateWhen(kindIs('ready'));
        // A switch holds the server for the 300 ms of its stop.
        const next = yield* launchOf();
        const switching = yield* Effect.forkChild(supervisor.switchTo(next));
        yield* stateWhen(kindIs('stopping'));
        const other = yield* launchOf();
        const during = yield* Effect.flip(supervisor.start(other));
        assert.deepStrictEqual(
          [during._tag, during.message],
          ['OperationInProgress', 'operation in progress, try again'],
        );
        yield* Fiber.join(switching);
        const after = yield* Effect.flip(supervisor.start(other));
        assert.deepStrictEqual([after._tag, after.message], ['ServerAlreadyRunning', 'a server is already running']);
      }),
    ),
  );

  it.effect('a stop waits for the operation in progress', () =>
    fresh()(
      Effect.gen(function* () {
        const supervisor = yield* Supervisor;
        const cmd = yield* launchOf();
        const starting = yield* Effect.forkChild(supervisor.start(cmd), { startImmediately: true });
        const stopping = yield* Effect.forkChild(supervisor.stop, { startImmediately: true });
        yield* Fiber.join(starting);
        yield* Fiber.join(stopping);
        yield* assertState({ kind: 'idle' });
        const kinds = yield* publishedKinds;
        assert.deepStrictEqual(kinds, ['starting', 'stopping', 'idle']);
      }),
    ),
  );

  it.effect(
    'a start whose caller is interrupted still ends: the state is starting or ready with a live pid, and the next stop works',
    () =>
      fresh({ killTimeout: '300 millis' })(
        Effect.gen(function* () {
          const supervisor = yield* Supervisor;
          // Interrupted while the start probes the port.
          const first = yield* launchOf({ name: 'first', env: { FAKE_IGNORE_TERM: '1' } });
          const caller = yield* Effect.forkChild(supervisor.start(first), { startImmediately: true });
          yield* Fiber.interrupt(caller);
          const started = yield* stateWhen(kindIs('starting', 'ready'));
          yield* assertAlive(pidOf(started));

          // Interrupted while the switch waits for the old server to end (once the start above has ended).
          yield* stateWhen(kindIs('ready'));
          const second = yield* launchOf({ name: 'second' });
          const switching = yield* Effect.forkChild(supervisor.switchTo(second));
          yield* stateWhen(kindIs('stopping'));
          yield* Fiber.interrupt(switching);
          const switched = yield* stateWhen(
            (state) => kindIs('starting', 'ready')(state) && profileOf(state) === 'second',
          );
          yield* assertAlive(pidOf(switched));
          yield* assertGone(pidOf(started));

          yield* supervisor.stop.pipe(Effect.timeout('2 seconds'));
          yield* assertState({ kind: 'idle' });
          yield* assertGone(pidOf(switched));
        }),
      ),
  );

  it.effect(
    'a port where another service answers is PortInUse naming the port; where a llama-server answers, the state is external and PortInUse names its pid',
    () =>
      Effect.gen(function* () {
        const other = yield* httpStub((_req, res) => {
          res.writeHead(404).end('nothing here');
        });
        const port = yield* freePort;
        const outside = yield* fakeOutside({ port });
        const procRoot = yield* procNaming(outside.pid, port);
        yield* fresh({ procRoot })(
          Effect.gen(function* () {
            const refused = yield* refusedStart({ port: other.port });
            assert.deepInclude(refused, {
              _tag: 'PortInUse',
              message: `port ${other.port} is in use by another service`,
              port: other.port,
              by: 'other',
              pid: null,
            });
            yield* assertState({ kind: 'idle' });

            const taken = yield* refusedStart({ port });
            assert.deepInclude(taken, {
              _tag: 'PortInUse',
              message: `port in use by an external server (PID ${outside.pid})`,
              port,
              by: 'llama-server',
              pid: outside.pid,
            });
            yield* assertState({ kind: 'external', pid: outside.pid, port });
          }),
        );
      }),
  );

  it.effect(
    'in the external state, a start is refused while that server answers and goes through once it is gone',
    () =>
      fresh()(
        Effect.gen(function* () {
          const supervisor = yield* Supervisor;
          const port = yield* freePort;
          const outside = yield* Scope.make();
          yield* fakeOutside({ port }).pipe(Scope.provide(outside));
          const detected = yield* supervisor.detectExternal(port);
          assert.isTrue(detected);
          const refused = yield* refusedStart();
          assert.deepInclude(refused, { _tag: 'PortInUse', by: 'llama-server', port });
          yield* Scope.close(outside, Exit.void);
          yield* startFake();
          const kinds = yield* publishedKinds;
          assert.deepStrictEqual(kinds, ['external', 'idle', 'starting']);
        }),
      ),
  );

  it.effect('stop turns crashed into idle and leaves external as it is', () =>
    fresh()(
      Effect.gen(function* () {
        const supervisor = yield* Supervisor;
        yield* startFake({ cwd: '/no/such/folder' });
        yield* assertState({ kind: 'crashed' });
        yield* supervisor.stop;
        yield* assertState({ kind: 'idle' });

        const port = yield* freePort;
        yield* fakeOutside({ port });
        const detected = yield* supervisor.detectExternal(port);
        assert.isTrue(detected);
        yield* supervisor.stop;
        yield* assertState({ kind: 'external', port });
      }),
    ),
  );

  it.effect('switchTo stops the running server, then launches the other profile', () =>
    fresh()(
      Effect.gen(function* () {
        const supervisor = yield* Supervisor;
        yield* startFake({ name: 'first' });
        const first = yield* stateWhen(kindIs('ready'));
        const second = yield* launchOf({ name: 'second' });
        yield* supervisor.switchTo(second);
        const state = yield* assertState({ kind: 'starting', profile: 'second', profileId: second.profileId });
        yield* assertGone(pidOf(first));
        yield* assertAlive(pidOf(state));
        const last = yield* supervisor.lastCommand;
        assert.deepStrictEqual(last, Option.some(second));
      }),
    ),
  );

  it.effect('every change is published once as server-state, in the order it happened', () =>
    fresh()(
      Effect.gen(function* () {
        const supervisor = yield* Supervisor;
        const cmd = yield* startFake();
        const starting = yield* supervisor.view;
        yield* stateWhen(kindIs('ready'));
        const ready = yield* supervisor.view;
        yield* supervisor.stop;
        const idle = yield* supervisor.view;
        const views = yield* publishedViews;
        assert.deepStrictEqual(
          Arr.map(views, (view) => view.state.kind),
          ['starting', 'ready', 'stopping', 'idle'],
        );
        assert.deepStrictEqual(views[0], starting);
        assert.deepStrictEqual(views[1], ready);
        assert.deepStrictEqual(views[3], idle);
        assert.deepStrictEqual(idle, { state: { kind: 'idle' }, command: cmd.display, profileId: cmd.profileId });
      }),
    ),
  );

  it.effect('the health poll reaches the address llama-server listens on (#28)', () =>
    fresh()(
      Effect.gen(function* () {
        yield* startFake({ host: '127.0.0.2' });
        const ready = yield* stateWhen(kindIs('ready'));
        assert.deepInclude(ready, { kind: 'ready', host: '127.0.0.2' });
      }),
    ),
  );

  it.effect(
    'detectExternal: a llama-server on the port is external with its pid; not while a server is managed; another service is not one',
    () =>
      Effect.gen(function* () {
        const port = yield* freePort;
        const outside = yield* fakeOutside({ port });
        const other = yield* httpStub((_req, res) => {
          res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html>');
        });
        const procRoot = yield* procNaming(outside.pid, port);
        yield* fresh({ procRoot })(
          Effect.gen(function* () {
            const supervisor = yield* Supervisor;
            const onOther = yield* supervisor.detectExternal(other.port);
            assert.isFalse(onOther);
            yield* startFake();
            const whileManaged = yield* supervisor.detectExternal(port);
            assert.isFalse(whileManaged);
            yield* assertState({ kind: 'starting' });
            yield* supervisor.stop;
            const detected = yield* supervisor.detectExternal(port);
            assert.isTrue(detected);
            yield* assertState({ kind: 'external', pid: outside.pid, port });
          }),
        );
      }),
  );

  it.effect('recheckExternal: a silent server whose pid is alive stays external; gone, the state is idle', () =>
    Effect.gen(function* () {
      const port = yield* freePort;
      const first = yield* Scope.make();
      const fake = yield* fakeOutside({ port }).pipe(Scope.provide(first));
      // The test process stands for a server that is alive but no longer answers.
      const hung = yield* procNaming(process.pid, port);
      yield* fresh({ procRoot: hung })(
        Effect.gen(function* () {
          const supervisor = yield* Supervisor;
          const detected = yield* supervisor.detectExternal(port);
          assert.isTrue(detected);
          yield* Scope.close(first, Exit.void);
          yield* assertGone(fake.pid);
          yield* supervisor.recheckExternal;
          yield* assertState({ kind: 'external', pid: process.pid, port });
        }),
      );

      const again = yield* Scope.make();
      const second = yield* fakeOutside({ port }).pipe(Scope.provide(again));
      const procRoot = yield* procNaming(second.pid, port);
      yield* fresh({ procRoot })(
        Effect.gen(function* () {
          const supervisor = yield* Supervisor;
          const detected = yield* supervisor.detectExternal(port);
          assert.isTrue(detected);
          yield* supervisor.recheckExternal;
          yield* assertState({ kind: 'external', pid: second.pid });
          yield* Scope.close(again, Exit.void);
          yield* supervisor.recheckExternal;
          yield* assertState({ kind: 'idle' });
        }),
      );
    }),
  );

  it.effect('the end of the layer stops llama-server', () =>
    Effect.gen(function* () {
      const plain = yield* fresh()(
        Effect.gen(function* () {
          yield* startFake();
          return yield* stateWhen(kindIs('ready'));
        }),
      );
      yield* assertGone(pidOf(plain));
    }),
  );

  it.effect('the end of the layer kills a server that ignores SIGTERM after the timeout', () =>
    Effect.gen(function* () {
      const before = yield* Clock.currentTimeMillis;
      const stubborn = yield* fresh({ killTimeout: '300 millis' })(
        Effect.gen(function* () {
          yield* startFake({ env: { FAKE_IGNORE_TERM: '1' } });
          return yield* stateWhen(kindIs('ready'));
        }),
      );
      const after = yield* Clock.currentTimeMillis;
      yield* assertGone(pidOf(stubborn));
      assert.isBelow(after - before, 3000);
    }),
  );
});
