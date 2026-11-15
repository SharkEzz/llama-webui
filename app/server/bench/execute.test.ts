import { assert, describe, it } from '@effect/vitest';
import { type BenchLive, BenchSpec, type BenchSpecInput, type GpuSample, isOomError } from '@llama-webui/shared';
import {
  Array as Arr,
  ConfigProvider,
  Deferred,
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
import { health } from '../llama/probes.ts';
import { LogRing } from '../logs/LogRing.ts';
import { ProfilesRepo } from '../profiles/ProfilesRepo.ts';
import { SettingsRepo } from '../settings/SettingsRepo.ts';
import { FAKE, freePort } from '../testing/llama.ts';
import { ServicesWithoutQueue } from '../testing/services.ts';
import { commandOf, type ExecResult, execute } from './execute.ts';
import { WARMUP_PROMPT } from './prompt.ts';

/** `test` on the services of the routes, an empty model file in a folder of its own. */
const fresh = <A, E>(
  test: (model: string) => Effect.Effect<A, E, Layer.Success<typeof ServicesWithoutQueue> | Scope.Scope>,
) =>
  Layer.build(ServicesWithoutQueue).pipe(
    Effect.flatMap((context) =>
      Effect.provideContext(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const dir = yield* fs.makeTempDirectoryScoped({ prefix: 'lw-bench-' });
          const model = path.join(dir, 'a.gguf');
          yield* fs.writeFileString(model, '');
          return yield* test(model);
        }),
        context,
      ),
    ),
    Effect.scoped,
  );

const specOf = (input: BenchSpecInput) => Schema.decodeEffect(BenchSpec)(input).pipe(Effect.orDie);

/** The fake as llama-server (llama-bench next to it), on `port`, with these variables. */
const useFake = Effect.fn(function* (options: { readonly port: number; readonly env?: Record<string, string> }) {
  const settings = yield* SettingsRepo;
  yield* settings.patch({ binary: FAKE, port: options.port, env: options.env ?? {} }).pipe(Effect.orDie);
});

/** A profile with these variables and this folder: its id. */
const profileWith = Effect.fn(function* (options: { readonly env?: Record<string, string>; readonly cwd?: string }) {
  const profiles = yield* ProfilesRepo;
  const created = yield* profiles
    .create({
      name: 'source',
      model: 'm.gguf',
      args: [],
      env: options.env ?? {},
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    })
    .pipe(Effect.orDie);
  return created.id;
});

/** Executes `spec` as run 1; the live views it went through, and its result. */
const executed = Effect.fn(function* (
  spec: BenchSpec,
  options: {
    readonly gpus?: Effect.Effect<ReadonlyArray<GpuSample>>;
    readonly cancel?: Deferred.Deferred<void>;
  } = {},
) {
  const lives = yield* Ref.make<ReadonlyArray<BenchLive>>([]);
  const command = yield* commandOf(spec);
  const cancel = options.cancel ?? (yield* Deferred.make<void>());
  const result: ExecResult = yield* execute({
    run: { id: 1, kind: spec.kind, command: command.display },
    spec,
    startedAt: 0,
    onLive: (live) => Ref.update(lives, Arr.append(live)),
    killTimeout: '1 second',
    cancel,
    gpus: options.gpus ?? Effect.succeed([]),
    disk: Effect.succeed(null),
  });
  return { result, lives: yield* Ref.get(lives), command };
});

const ringTexts = Effect.gen(function* () {
  const ring = yield* LogRing;
  const lines = yield* ring.since(0);
  return Arr.map(lines, (line) => line.text);
});

describe('execute', () => {
  it.live('a server run measures r times and reports draft acceptance', () =>
    fresh((model) =>
      Effect.gen(function* () {
        const port = yield* freePort;
        yield* useFake({ port, env: { FAKE_PP: '1000', FAKE_TG: '50', FAKE_DRAFT: '1', FAKE_LOAD_MS: '50' } });
        const spec = yield* specOf({ kind: 'server', modelPath: model, r: 2, p: 64, n: 8 });
        const { result, command } = yield* executed(spec);
        assert.strictEqual(result.error, null);
        assert.strictEqual(result.status, 'ok');
        assert.strictEqual(result.pp?.tps, 1000);
        assert.strictEqual(result.pp?.stddev, 0);
        assert.isNumber(result.pp?.tokens);
        assert.strictEqual(result.tg?.tps, 50);
        assert.strictEqual(result.tg?.stddev, 0);
        assert.strictEqual(result.draftAcceptPct, 47.5);
        assert.include(command.display, `--port ${port}`);
        const after = yield* health({ host: '127.0.0.1', port });
        assert.deepStrictEqual(after, Option.none());
      }),
    ),
  );

  it.live("a bench run gets its profile's environment", () =>
    fresh((model) =>
      Effect.gen(function* () {
        yield* useFake({ port: yield* freePort });
        const profileId = yield* profileWith({ env: { FAKE_BENCH_OOM: '1' } });
        const spec = yield* specOf({ kind: 'bench', modelPath: model, profileId, r: 1 });
        const { result } = yield* executed(spec);
        assert.strictEqual(result.status, 'failed');
      }),
    ),
  );

  it.live('a server that dies of OOM is reported as OOM even when a long backtrace follows the allocation error', () =>
    fresh((model) =>
      Effect.gen(function* () {
        // llama.cpp prints a gdb backtrace on GGML_ASSERT: more lines than the trial keeps after the cudaMalloc failure.
        const backtrace = Arr.makeBy(80, (i) => `#${i}  0x00007f739bb3219b in frame_${i} () from libggml-base.so.0`);
        const lines = [
          'ggml_backend_cuda_buffer_type_alloc_buffer: allocating 8192.00 MiB on device 0: cudaMalloc failed: out of memory',
          'ggml-backend-meta.cpp:1857: GGML_ASSERT(meta_buf_ctx->bufs[i]) failed',
          ...backtrace,
        ];
        yield* useFake({ port: yield* freePort });
        const profileId = yield* profileWith({ env: { FAKE_EXIT_LINES: Arr.join(lines, '|') } });
        const spec = yield* specOf({ kind: 'server', modelPath: model, profileId, r: 1, p: 16, n: 4 });
        const { result } = yield* executed(spec);
        assert.strictEqual(result.status, 'failed');
        assert.isTrue(isOomError(result.error ?? null));
        assert.include(result.error, 'cudaMalloc failed: out of memory');
      }),
    ),
  );

  it.effect(
    'the warm-up prompt is a sentence: a 2-token prompt crashes llama-server with -sm tensor and an MTP draft',
    () =>
      Effect.sync(() => {
        // llama.cpp segfaults on a 2-token prompt with -sm tensor and --spec-type draft-mtp ("Hello." did, every time).
        const words = Arr.filter(Str.split(WARMUP_PROMPT, ' '), Str.isNonEmpty);
        assert.isAtLeast(words.length, 6);
      }),
  );

  it.live("a server run runs in its profile's directory", () =>
    fresh((model) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectoryScoped({ prefix: 'lw-cwd-' });
        yield* useFake({ port: yield* freePort, env: { FAKE_LOAD_MS: '50' } });
        const profileId = yield* profileWith({ cwd });
        const spec = yield* specOf({ kind: 'server', modelPath: model, profileId, r: 1, p: 16, n: 4 });
        const { result } = yield* executed(spec);
        assert.include(result.logExcerpt, `cwd ${cwd}`);
      }),
    ),
  );

  it.live('the VRAM sampler takes its last reading when the run ends, then stops', () =>
    fresh((model) =>
      Effect.gen(function* () {
        for (const kind of ['bench', 'server'] as const) {
          // A card holding 1 GiB when the run starts, 3 GiB afterwards.
          const calls = yield* Ref.make(0);
          const gpus = Ref.getAndUpdate(calls, (n) => n + 1).pipe(
            Effect.map(
              (n): ReadonlyArray<GpuSample> => [
                {
                  key: 'g0',
                  vendor: 'other',
                  name: 'Fake GPU',
                  vramUsedBytes: (n === 0 ? 1 : 3) * 1024 ** 3,
                } as unknown as GpuSample,
              ],
            ),
          );
          yield* useFake({ port: yield* freePort, env: { FAKE_LOAD_MS: '50' } });
          const spec = yield* specOf({ kind, modelPath: model, r: 1, p: 16, n: 4 });
          const { result } = yield* executed(spec, { gpus });
          assert.strictEqual(result.status, 'ok');
          assert.deepStrictEqual(result.vramPeak, [{ key: 'g0', name: 'Fake GPU', mib: 2048 }]);
          // Released with the run: no reading afterwards (a leaked sampler would keep polling).
          const after = yield* Ref.get(calls);
          yield* Effect.sleep('1200 millis');
          const later = yield* Ref.get(calls);
          assert.strictEqual(later, after);
        }
      }),
    ),
  );

  it.live('a llama-bench run parses its progress into steps and its JSON into pp and tg', () =>
    fresh((model) =>
      Effect.gen(function* () {
        yield* useFake({ port: yield* freePort, env: { FAKE_PP: '900', FAKE_TG: '40', FAKE_BENCH_STEP_MS: '10' } });
        const spec = yield* specOf({ kind: 'bench', modelPath: model, r: 2 });
        const { result, lives } = yield* executed(spec);
        assert.strictEqual(result.status, 'ok');
        assert.strictEqual(result.pp?.tps, 900);
        assert.strictEqual(result.tg?.tps, 40);
        // Two tests of two runs: the steps 1..4 out of 4, in the prompt then the generation phase.
        const steps = Arr.dedupe(
          Arr.map(
            Arr.filter(lives, (l) => l.step !== null && l.phase !== 'warmup'),
            (l) => `${l.phase} ${l.step?.index}/${l.step?.total}`,
          ),
        );
        assert.deepStrictEqual(steps, ['prompt 1/4', 'prompt 2/4', 'generation 3/4', 'generation 4/4']);
        const last = Arr.last(lives).pipe(Option.getOrThrow);
        assert.isAtMost(last.lines.length, 20);
        assert.include(last.lines.at(-1), 'generation run 2/2');
      }),
    ),
  );

  it.live('a cancel sends SIGTERM, then SIGKILL after the timeout', () =>
    fresh((model) =>
      Effect.gen(function* () {
        const port = yield* freePort;
        // Never loads, ignores SIGTERM.
        yield* useFake({ port, env: { FAKE_IGNORE_TERM: '1', FAKE_LOAD_MS: '60000' } });
        const spec = yield* specOf({ kind: 'server', modelPath: model, r: 1, p: 16, n: 4 });
        const cancel = yield* Deferred.make<void>();
        const running = yield* Effect.forkChild(executed(spec, { cancel }));
        // Loading: it answers 503.
        yield* health({ host: '127.0.0.1', port }).pipe(
          Effect.repeat({ schedule: Schedule.spaced('20 millis'), until: Option.isSome }),
          Effect.timeout('5 seconds'),
        );
        yield* Deferred.succeed(cancel, undefined);
        const { result } = yield* Fiber.join(running);
        assert.strictEqual(result.status, 'cancelled');
        const texts = yield* ringTexts;
        // In this order: the request, SIGTERM ignored, then SIGKILL.
        const cancelAt = texts.indexOf('[bench] cancellation requested');
        assert.isAtLeast(cancelAt, 0);
        assert.deepStrictEqual(Arr.drop(texts, cancelAt), [
          '[bench] cancellation requested',
          '[bench] 0.00.000.000 I srv  main: ignoring SIGTERM',
          '[llama-webui] not stopped after 1000 ms, SIGKILL',
        ]);
        const after = yield* health({ host: '127.0.0.1', port });
        assert.deepStrictEqual(after, Option.none());
      }),
    ),
  );

  it.live('the bench binary is taken from the binary setting with ~ expanded', () =>
    fresh((model) =>
      Effect.gen(function* () {
        const settings = yield* SettingsRepo;
        yield* settings.patch({ binary: '~/llama.cpp/build/bin/llama-server' }).pipe(Effect.orDie);
        const spec = yield* specOf({ kind: 'bench', modelPath: model, r: 1 });
        const command = yield* commandOf(spec).pipe(
          Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnv({ env: { HOME: '/home/demo' } })),
        );
        assert.deepStrictEqual(Arr.take(command.argv, 6), [
          'setpriv',
          '--pdeathsig',
          'KILL',
          '--',
          '/home/demo/llama.cpp/build/bin/llama-bench',
          '-m',
        ]);
        assert.isTrue(Str.startsWith('/home/demo/llama.cpp/build/bin/llama-bench -m ')(command.display));
      }),
    ),
  );
});
