import { assert, describe, it } from '@effect/vitest';
import { DEFAULT_SETTINGS, type LoadProgress, type Profile } from '@llama-webui/shared';
import { Array as Arr, type Duration, Effect, Layer, Option, Ref, type Scope } from 'effect';
import { health } from '../llama/probes.ts';
import { buildCommand } from '../supervisor/command.ts';
import { FAKE, fakeOutside, freePort } from '../testing/llama.ts';
import { ServicesWithoutBench } from '../testing/services.ts';
import { runTrial } from './trial.ts';

const fresh = <A, E>(test: Effect.Effect<A, E, Layer.Success<typeof ServicesWithoutBench> | Scope.Scope>) =>
  Layer.build(ServicesWithoutBench).pipe(
    Effect.flatMap((context) => Effect.provideContext(test, context)),
    Effect.scoped,
  );

/** The command of the fake on `port`, with these variables. */
const fakeOn = (port: number, env: Record<string, string>) => {
  const profile: Profile = {
    id: 0,
    name: 'bench',
    model: 'm.gguf',
    args: [],
    env,
    host: '127.0.0.1',
    port,
    source: 'ui',
    createdAt: 0,
    updatedAt: 0,
  };
  return buildCommand({ profile, settings: { ...DEFAULT_SETTINGS, binary: FAKE } });
};

const trialOf = (cmd: Effect.Success<ReturnType<typeof fakeOn>>, loadTimeout?: Duration.Input) =>
  runTrial({
    cmd,
    p: 16,
    n: 4,
    r: 1,
    onPhase: () => Effect.void,
    onLine: () => Effect.void,
    onSpawn: () => Effect.void,
    say: () => Effect.void,
    killTimeout: '1 second',
    healthPoll: '50 millis',
    ...(loadTimeout === undefined ? {} : { loadTimeout }),
  });

describe('trial', () => {
  it.live('a trial on a port already in use fails with port <port> is used by another server', () =>
    fresh(
      Effect.gen(function* () {
        const port = yield* freePort;
        yield* fakeOutside({ port });
        const cmd = yield* fakeOn(port, { FAKE_LOAD_MS: '50' });
        const failed = yield* Effect.flip(trialOf(cmd));
        assert.strictEqual(failed.message, `port ${port} is used by another server`);
      }),
    ),
  );

  it.live('a request that gets another status fails with <path> responded <status>', () =>
    fresh(
      Effect.gen(function* () {
        const port = yield* freePort;
        // A context of 10 tokens: the measured chat request is refused with a 400.
        const cmd = yield* fakeOn(port, { FAKE_LOAD_MS: '50', FAKE_N_CTX: '10' });
        const failed = yield* Effect.flip(trialOf(cmd));
        assert.strictEqual(failed.message, '/v1/chat/completions responded 400');
        // Stopped at the end.
        const after = yield* health({ host: '127.0.0.1', port });
        assert.deepStrictEqual(after, Option.none());
      }),
    ),
  );

  it.live('a trial forwards /models/sse loading progress before warmup and measurement', () =>
    fresh(
      Effect.gen(function* () {
        const port = yield* freePort;
        const cmd = yield* fakeOn(port, {
          FAKE_SSE: '1',
          FAKE_SSE_STAGES: 'text_model,mmproj_model',
          FAKE_LOAD_MS: '180',
        });
        const seen = yield* Ref.make<ReadonlyArray<LoadProgress>>([]);
        const result = yield* runTrial({
          cmd,
          p: 16,
          n: 4,
          r: 1,
          onPhase: () => Effect.void,
          onLoadProgress: (p) => Ref.update(seen, Arr.append(p)),
          onLine: () => Effect.void,
          onSpawn: () => Effect.void,
          say: () => Effect.void,
          killTimeout: '1 second',
          healthPoll: '50 millis',
        });
        const progress = yield* Ref.get(seen);
        assert.isAbove(progress.length, 0);
        assert.isTrue(Arr.some(progress, (p) => p.current === 'text_model'));
        assert.isAbove(result.pp.tps, 0);
        assert.isAbove(result.tg.tps, 0);
        const after = yield* health({ host: '127.0.0.1', port });
        assert.deepStrictEqual(after, Option.none());
      }),
    ),
  );

  it.live('a trial starts measuring through /health when SSE stays open without status events', () =>
    fresh(
      Effect.gen(function* () {
        const port = yield* freePort;
        const cmd = yield* fakeOn(port, { FAKE_SSE: '1', FAKE_SSE_STALL: 'events', FAKE_LOAD_MS: '50' });
        const measured = yield* trialOf(cmd, '1 second');
        assert.isAbove(measured.tg.tps, 0);
        const after = yield* health({ port });
        assert.deepStrictEqual(after, Option.none());
      }),
    ),
  );
});
