import { NodeServices } from '@effect/platform-node';
import { assert, describe, it } from '@effect/vitest';
import { DEFAULT_SETTINGS, type Profile, type ServerState } from '@llama-webui/shared';
import { Array as Arr, Effect, Fiber, Layer, Option, Schedule, type Scope, String as Str } from 'effect';
import { TestClock } from 'effect/testing';
import { LogRing } from '../logs/LogRing.ts';
import { type BuiltCommand, buildCommand } from '../supervisor/command.ts';
import { Supervisor } from '../supervisor/Supervisor.ts';
import { FAKE, fakeOutside, freePort, httpStub } from '../testing/llama.ts';
import { ServicesWithoutBench } from '../testing/services.ts';
import { WsHub } from '../ws/WsHub.ts';
import { makeGate } from './gate.ts';

/** `test` on the services of the routes, whose end stops the managed server. */
const fresh = <A, E>(test: Effect.Effect<A, E, Layer.Success<typeof ServicesWithoutBench> | Scope.Scope>) =>
  Layer.build(ServicesWithoutBench).pipe(
    Effect.flatMap((context) => Effect.provideContext(test, context)),
    Effect.scoped,
  );

/** The command of profile `id` named `name` that runs the fake on `port`, with `args` (they show in its display). */
const commandOf = (options: {
  readonly id: number;
  readonly name: string;
  readonly port: number;
  readonly args?: ReadonlyArray<string>;
}) => {
  const profile: Profile = {
    id: options.id,
    name: options.name,
    model: 'm.gguf',
    args: [...(options.args ?? [])],
    env: {},
    port: options.port,
    source: 'ui',
    createdAt: 0,
    updatedAt: 0,
  };
  return buildCommand({ profile, settings: { ...DEFAULT_SETTINGS, binary: FAKE, host: '127.0.0.1' } });
};

/** The fake started as profile 1, `A`: its command. */
const startA = Effect.gen(function* () {
  const supervisor = yield* Supervisor;
  const port = yield* freePort;
  const cmd = yield* commandOf({ id: 1, name: 'A', port, args: ['--alias', 'before'] });
  yield* supervisor.start(cmd);
  yield* stateWhen((s) => s.kind === 'ready');
  return cmd;
});

const stateWhen = Effect.fnUntraced(function* (ok: (state: ServerState) => boolean) {
  const supervisor = yield* Supervisor;
  return yield* supervisor.state.pipe(
    Effect.repeat({ schedule: Schedule.spaced('10 millis'), until: ok }),
    Effect.timeout('5 seconds'),
  );
});

const lastDisplay = Effect.gen(function* () {
  const supervisor = yield* Supervisor;
  const last = yield* supervisor.lastCommand;
  return Option.map(last, (cmd) => cmd.display);
});

const benchLines = Effect.gen(function* () {
  const ring = yield* LogRing;
  const lines = yield* ring.since(0);
  return Arr.filter(
    Arr.map(lines, (line) => line.text),
    (text) => Str.startsWith('[bench]')(text),
  );
});

const never = (_: BuiltCommand) => Effect.succeed(Option.none<BuiltCommand>());

describe('gate on the supervisor', () => {
  it.live('the server stopped for a benchmark restarts with the profile as it is now (#39)', () =>
    fresh(
      Effect.gen(function* () {
        const gate = yield* makeGate({ stoppingTimeout: '60 seconds' });
        const before = yield* startA;
        const edited = yield* commandOf({ id: 1, name: 'A', port: before.port, args: ['--alias', 'edited'] });
        yield* gate.acquire({ stopServer: true });
        yield* gate.ready;
        const stopped = yield* stateWhen((s) => s.kind === 'idle');
        assert.strictEqual(stopped.kind, 'idle');
        yield* gate.release((cmd) => Effect.succeed(cmd.profileId === 1 ? Option.some(edited) : Option.none()));
        yield* stateWhen((s) => s.kind === 'ready');
        const display = yield* lastDisplay;
        assert.deepStrictEqual(display, Option.some(edited.display));
      }),
    ),
  );

  it.live('without a rebuilt command (profile deleted), the recorded one is used (#39)', () =>
    fresh(
      Effect.gen(function* () {
        const gate = yield* makeGate({ stoppingTimeout: '60 seconds' });
        const before = yield* startA;
        yield* gate.acquire({ stopServer: true });
        yield* gate.release(never);
        yield* stateWhen((s) => s.kind === 'ready');
        const display = yield* lastDisplay;
        assert.deepStrictEqual(display, Option.some(before.display));
      }),
    ),
  );

  it.live('an external server is a 409 that names its port', () =>
    fresh(
      Effect.gen(function* () {
        const supervisor = yield* Supervisor;
        const gate = yield* makeGate({ stoppingTimeout: '60 seconds' });
        const port = yield* freePort;
        yield* fakeOutside({ port });
        const detected = yield* supervisor.detectExternal(port);
        assert.isTrue(detected);
        const refused = yield* Effect.flip(gate.acquire({ stopServer: true }));
        assert.strictEqual(refused._tag, 'ExternalServerRunning');
        assert.strictEqual(refused.message, `An external llama-server is running on port ${port}: stop it first`);
        const held = yield* gate.held;
        assert.isFalse(held);
      }),
    ),
  );

  it.live('a running server without stopServer is a 409 ServerRunning that names the profile', () =>
    fresh(
      Effect.gen(function* () {
        const gate = yield* makeGate({ stoppingTimeout: '60 seconds' });
        yield* startA;
        const refused = yield* Effect.flip(gate.acquire({ stopServer: false }));
        assert.strictEqual(refused._tag, 'ServerRunning');
        assert.strictEqual(
          refused.message,
          'llama-server is running (profile A): it will be stopped during the benchmark, then restarted',
        );
        const held = yield* gate.held;
        assert.isFalse(held);
        const still = yield* stateWhen((s) => s.kind === 'ready');
        assert.strictEqual(still.kind, 'ready');
      }),
    ),
  );

  it.live('the gate pushes its two [bench] lines and its failure line to the ring', () =>
    fresh(
      Effect.gen(function* () {
        const gate = yield* makeGate({ stoppingTimeout: '60 seconds' });
        yield* startA;
        // The port of the rebuilt command is taken by another service: the restart fails.
        const other = yield* httpStub((_, res) => res.end('not llama'));
        const elsewhere = yield* commandOf({ id: 1, name: 'A', port: other.port });
        yield* gate.acquire({ stopServer: true });
        yield* gate.ready;
        const failed = yield* Effect.flip(gate.release(() => Effect.succeedSome(elsewhere)));
        assert.strictEqual(failed._tag, 'RestartFailed');
        assert.strictEqual(
          failed.message,
          `could not restart llama-server: port ${other.port} is in use by another service`,
        );
        const lines = yield* benchLines;
        assert.deepStrictEqual(lines, [
          '[bench] stopping llama-server for the benchmark',
          '[bench] restarting llama-server (A)',
          `[bench] could not restart llama-server: port ${other.port} is in use by another service`,
        ]);
        // Freed anyway.
        const held = yield* gate.held;
        assert.isFalse(held);
      }),
    ),
  );

  it.live('release without a stop does nothing and twice is once', () =>
    fresh(
      Effect.gen(function* () {
        const gate = yield* makeGate({ stoppingTimeout: '60 seconds' });
        // Nothing runs: the gate is taken, nothing is stopped, the release restarts nothing.
        yield* gate.acquire({ stopServer: true });
        const taken = yield* gate.held;
        assert.isTrue(taken);
        yield* gate.release(never);
        const idle = yield* benchLines;
        assert.deepStrictEqual(idle, []);
        const freed = yield* gate.held;
        assert.isFalse(freed);
        // Two releases at once restart once; a third, after them, does nothing.
        yield* startA;
        yield* gate.acquire({ stopServer: true });
        yield* Effect.all([gate.release(never), gate.release(never)], { concurrency: 2 });
        yield* gate.release(never);
        yield* stateWhen((s) => s.kind === 'ready');
        const lines = yield* benchLines;
        assert.deepStrictEqual(lines, [
          '[bench] stopping llama-server for the benchmark',
          '[bench] restarting llama-server (A)',
        ]);
      }),
    ),
  );
});

/** A supervisor whose server never finishes stopping. */
const StillStopping = Layer.succeed(
  Supervisor,
  Supervisor.of({
    state: Effect.succeed({
      kind: 'stopping',
      profile: 'A',
      profileId: 1,
      pid: 1,
      host: '127.0.0.1',
      port: 8080,
    }),
    lastCommand: Effect.succeedNone,
    view: Effect.die('not used'),
    changes: Effect.die('not used'),
    start: () => Effect.die('not used'),
    switchTo: () => Effect.die('not used'),
    stop: Effect.void,
    detectExternal: () => Effect.die('not used'),
    recheckExternal: Effect.void,
  }),
).pipe(
  Layer.provideMerge(LogRing.layer),
  Layer.provideMerge(
    Layer.succeed(WsHub, WsHub.of({ publish: () => Effect.void, size: Effect.succeed(0), attach: () => Effect.void })),
  ),
  Layer.provideMerge(NodeServices.layer),
);

describe('gate on a stop that never ends', () => {
  it.effect('a stop that takes longer than the timeout is a 409 and the gate stays free', () =>
    Layer.build(StillStopping).pipe(
      Effect.flatMap((context) =>
        Effect.provideContext(
          Effect.gen(function* () {
            const gate = yield* makeGate({ stoppingTimeout: '60 seconds', poll: '100 millis' });
            const acquiring = yield* gate.acquire({ stopServer: true }).pipe(Effect.flip, Effect.forkChild);
            yield* TestClock.adjust('59 seconds');
            const early = yield* Effect.sync(() => acquiring.pollUnsafe());
            assert.isUndefined(early);
            yield* TestClock.adjust('2 seconds');
            const refused = yield* Fiber.join(acquiring);
            assert.strictEqual(refused._tag, 'ServerStopTooSlow');
            assert.strictEqual(refused.message, 'llama-server is taking too long to stop: try again');
            const held = yield* gate.held;
            assert.isFalse(held);
          }),
          context,
        ),
      ),
      Effect.scoped,
    ),
  );
});
