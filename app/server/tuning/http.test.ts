import { NodeServices } from '@effect/platform-node';
import { assert, layer } from '@effect/vitest';
import { ChecksReport, Estimate, PlanResult, TuningHardware as TuningHardwareSchema } from '@llama-webui/shared';
import {
  Array as Arr,
  ConfigProvider,
  Context,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Ref,
  Schema,
  String as Str,
} from 'effect';
import { HttpClient, HttpClientRequest } from 'effect/http';
import { BenchRunner } from '../bench/BenchRunner.ts';
import { Downloads } from '../downloads/Downloads.ts';
import { ApiRoutes, serve } from '../http/HttpLive.ts';
import { SettingsRepo } from '../settings/SettingsRepo.ts';
import { sweepSpec } from '../testing/bench.ts';
import { type KvValue, writeGguf } from '../testing/gguf.ts';
import { ServerTest } from '../testing/http.ts';
import { ServicesWithoutBench } from '../testing/services.ts';
import { locksMemory } from './estimate.ts';
import { TuningMemo } from './TuningMemo.ts';

/** The home of the test (`HOME`, and `~/bin` the whole `PATH`): nothing of the user's is found or run. */
class Home extends Context.Service<Home, string>()('@llama-webui/app/server/tuning/http.test/Home') {}

const homeConfig = ConfigProvider.layerAdd(
  Effect.map(Home, (home) => ConfigProvider.fromUnknown({ HOME: home, PATH: `${home}/bin` })),
  { asPrimary: true },
).pipe(
  Layer.provideMerge(
    Layer.effect(
      Home,
      Effect.flatMap(FileSystem.FileSystem, (fs) => fs.makeTempDirectoryScoped({ prefix: 'lw-tuning-http-' })),
    ),
  ),
);

/** Whether the runner says a benchmark runs. */
class Busy extends Context.Service<Busy, Ref.Ref<boolean>>()('@llama-webui/app/server/tuning/http.test/Busy') {}

/** A runner that runs nothing, busy when `Busy` says so. */
const StubRunner = Layer.effect(
  BenchRunner,
  Effect.gen(function* () {
    const busy = yield* Busy;
    const unused = Effect.die('not used by the test');
    return BenchRunner.of({
      busy: Ref.get(busy),
      live: Effect.succeed(null),
      sweepLive: Effect.succeed(null),
      files: Effect.succeed([]),
      start: () => unused,
      startSweep: () => unused,
      resume: () => unused,
      validate: () => unused,
      cancel: () => unused,
      cancelSweep: () => unused,
    });
  }),
).pipe(Layer.provideMerge(Layer.effect(Busy, Ref.make(false))));

/** The routes on the services of the app, the stub runner in place of the real one, a home of the test's own. */
const served = serve(ApiRoutes).pipe(
  Layer.provideMerge(
    Downloads.layerWith({
      freeBytes: () => Effect.succeed(null),
      retryDelays: [],
      stall: '5 seconds',
      liveEvery: '0 millis',
    }),
  ),
  Layer.provideMerge(StubRunner),
  Layer.provideMerge(ServicesWithoutBench),
  Layer.provideMerge(ServerTest),
  Layer.provideMerge(homeConfig),
  Layer.provideMerge(NodeServices.layer),
);

const parseJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const toJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

/** The status and the JSON value of a request; `body` is sent as JSON. */
const send = Effect.fnUntraced(function* (method: 'GET' | 'POST', path: string, body?: unknown) {
  const client = yield* HttpClient.HttpClient;
  const base = HttpClientRequest.make(method)(path);
  const text = body === undefined ? undefined : yield* toJson(body);
  const request = text === undefined ? base : HttpClientRequest.bodyText(base, text, 'application/json');
  const res = yield* client.execute(request);
  const answer = yield* res.text;
  const json: unknown = Str.isNonEmpty(answer) ? yield* parseJson(answer) : undefined;
  return { status: res.status, json };
});

/** A 2xx reply as the schema reads it. */
const ok = Effect.fnUntraced(function* <A, I>(
  schema: Schema.Codec<A, I>,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
) {
  const res = yield* send(method, path, body);
  assert.strictEqual(res.status, 200, `${method} ${path}`);
  return yield* Schema.decodeUnknownEffect(schema)(res.json);
});

const Failure = Schema.Struct({
  _tag: Schema.String,
  message: Schema.String,
  issues: Schema.Struct({ path: Schema.Array(Schema.Unknown) }).pipe(Schema.Array, Schema.optionalKey),
});

/** The status, `_tag` and `message` of an error reply, and the paths of its issues. */
const failure = Effect.fnUntraced(function* (method: 'GET' | 'POST', path: string, body?: unknown) {
  const res = yield* send(method, path, body);
  const { _tag, message, issues } = yield* Schema.decodeUnknownEffect(Failure)(res.json);
  return {
    status: res.status,
    _tag,
    message,
    paths: Arr.map(issues ?? [], (issue) => Arr.join(Arr.map(issue.path, String), '.')),
  };
});

const str = (value: string): KvValue => ({ type: 'string', value });
const u32 = (value: number): KvValue => ({ type: 'u32', value });

const MiB = 1024 ** 2;

/** A llama GGUF at `~/models/<name>` whose weights take `bytes`; its path. */
const model = Effect.fnUntraced(function* (name: string, bytes = 256 * 1024, kv: Record<string, KvValue> = {}) {
  const home = yield* Home;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = path.join(home, 'models', name);
  yield* fs.makeDirectory(path.dirname(file), { recursive: true });
  const quarter = Math.floor(bytes / 4);
  yield* Effect.promise(() =>
    writeGguf(
      file,
      {
        'general.architecture': str('llama'),
        'general.name': str(name),
        'llama.block_count': u32(2),
        'llama.embedding_length': u32(256),
        'llama.attention.head_count': u32(4),
        'llama.attention.head_count_kv': u32(4),
        'llama.context_length': u32(4096),
        ...kv,
      },
      [
        { name: 'token_embd.weight', shape: [256, 64], bytes: quarter },
        { name: 'blk.0.attn_q.weight', shape: [256, 256], bytes: quarter },
        { name: 'blk.1.attn_q.weight', shape: [256, 256], bytes: quarter },
        { name: 'output.weight', shape: [256, 64], bytes: quarter },
      ],
    ),
  );
  return file;
});

/** No llama.cpp under the test's home: llama-bench lists no device, the estimates plan on the CPU. */
const noBinary = Effect.gen(function* () {
  const home = yield* Home;
  const settings = yield* SettingsRepo;
  yield* settings.patch({ binary: `${home}/bin/llama-server` });
});

const checksOf = (modelPath: string) =>
  ok(ChecksReport, 'GET', `/api/tuning/checks?model=${encodeURIComponent(modelPath)}`);

const checkOf = (report: ChecksReport, id: string) => Arr.findFirst(report.checks, (c) => c.id === id);

layer(served, { excludeTestServices: true, buildPerTest: true })('/api/tuning over HTTP', (it) => {
  it.effect('the hardware lists no device without llama-bench, and says why', () =>
    Effect.gen(function* () {
      yield* noBinary;
      const hardware = yield* ok(TuningHardwareSchema, 'GET', '/api/tuning/hardware');
      assert.deepStrictEqual(hardware.devices, []);
      assert.isNotNull(hardware.devicesError);
    }),
  );

  it.effect('the estimate, then the disk measure, are kept for the checks of their model', () =>
    Effect.gen(function* () {
      yield* noBinary;
      const path = yield* model('big.gguf', 65 * MiB);
      const before = yield* checksOf(path);
      assert.strictEqual(Option.getOrThrow(checkOf(before, 'kernel.disk-speed')).state, 'unknown');

      const estimate = yield* ok(Estimate, 'POST', '/api/tuning/estimate', { modelPath: path, preset: 'fit' });
      const memo = yield* TuningMemo;
      const kept = yield* memo.estimates.get(path);
      assert.deepStrictEqual(
        Option.map(kept, (e) => [e.ok, e.preset, e.ctx, e.serverArgs]),
        Option.some([estimate.ok, estimate.preset, estimate.ctx, estimate.serverArgs]),
      );

      const speed = yield* ok(
        Schema.Struct({ sampledBytes: Schema.Finite, path: Schema.String }),
        'POST',
        '/api/tuning/disk-speed',
        { modelPath: path },
      );
      assert.strictEqual(speed.path, path);
      assert.isAbove(speed.sampledBytes, 64 * MiB);
      const measured = yield* memo.diskSpeeds.get(path);
      assert.isTrue(Option.isSome(measured));

      const after = yield* checksOf(path);
      const disk = Option.getOrThrow(checkOf(after, 'kernel.disk-speed'));
      assert.isTrue(Str.startsWith('sequential read')(disk.detail), disk.detail);
      // The memlock check follows the estimate kept: it reads `--load-mode mmap+mlock` in its args.
      const memlock = Option.getOrThrow(checkOf(after, 'cpu.memlock'));
      assert.strictEqual(
        memlock.detail === '--load-mode mmap+mlock not recommended here',
        !locksMemory(estimate.serverArgs),
      );
    }),
  );

  it.effect('an estimate that does not fit is kept too', () =>
    Effect.gen(function* () {
      yield* noBinary;
      // 64 layers of 32 KV heads of 256: ten million tokens of KV cache are terabytes, more than any machine's RAM.
      const path = yield* model('a.gguf', 256 * 1024, {
        'llama.block_count': u32(64),
        'llama.embedding_length': u32(8192),
        'llama.attention.head_count': u32(32),
        'llama.attention.head_count_kv': u32(32),
      });
      const estimate = yield* ok(Estimate, 'POST', '/api/tuning/estimate', {
        modelPath: path,
        preset: 'fit',
        ctx: 10_000_000,
      });
      assert.isFalse(estimate.ok);
      const memo = yield* TuningMemo;
      const kept = yield* memo.estimates.get(path);
      assert.deepStrictEqual(
        Option.map(kept, (e) => e.ok),
        Option.some(false),
      );
    }),
  );

  it.effect('the disk measure is refused while a benchmark runs, before the model is read', () =>
    Effect.gen(function* () {
      const busy = yield* Busy;
      yield* Ref.set(busy, true);
      const refused = yield* failure('POST', '/api/tuning/disk-speed', { modelPath: 'relative.gguf' });
      assert.deepInclude(refused, {
        status: 409,
        _tag: 'BenchRunning',
        message: 'A benchmark is running: the measurement would be skewed',
      });
    }),
  );

  it.effect('estimate, plan and disk speed answer the errors of the model loading', () =>
    Effect.gen(function* () {
      yield* noBinary;
      const home = yield* Home;
      const fs = yield* FileSystem.FileSystem;
      const good = yield* model('a.gguf');
      yield* fs.writeFileString(`${home}/models/bad.gguf`, 'not a gguf');
      // The spec of a plan checks the model's path when it is decoded: a 400 of the request, not of the loading.
      const cases: ReadonlyArray<
        readonly [string, { readonly modelPath: string; readonly mmprojPath?: string }, number, string, string]
      > = [
        ['relative', { modelPath: 'a.gguf' }, 400, 'ModelPathInvalid', 'RequestInvalid'],
        ['not a .gguf', { modelPath: `${home}/models/a.bin` }, 400, 'ModelPathInvalid', 'RequestInvalid'],
        ['missing', { modelPath: `${home}/models/gone.gguf` }, 404, 'ModelNotFound', 'ModelNotFound'],
        ['unreadable', { modelPath: `${home}/models/bad.gguf` }, 422, 'ModelUnreadable', 'ModelUnreadable'],
        [
          'no projector',
          { modelPath: good, mmprojPath: `${home}/models/gone-mmproj.gguf` },
          404,
          'ProjectorNotFound',
          'ProjectorNotFound',
        ],
      ];
      for (const [name, files, status, tag, planTag] of cases) {
        const estimate = yield* failure('POST', '/api/tuning/estimate', { ...files, preset: 'fit' });
        assert.deepStrictEqual([estimate.status, estimate._tag], [status, tag], `estimate: ${name}`);
        const plan = yield* failure('POST', '/api/tuning/plan', { spec: sweepSpec(files) });
        assert.deepStrictEqual([plan.status, plan._tag], [status, planTag], `plan: ${name}`);
      }
      const missing = yield* failure('POST', '/api/tuning/estimate', {
        modelPath: `${home}/models/gone.gguf`,
        preset: 'fit',
      });
      assert.strictEqual(missing.message, 'Model not found');
      const small = yield* failure('POST', '/api/tuning/disk-speed', { modelPath: good });
      assert.deepInclude(small, { status: 400, _tag: 'FileTooSmall', message: 'File too small to measure (0 MiB)' });
      const gone = yield* failure('POST', '/api/tuning/disk-speed', { modelPath: `${home}/models/gone.gguf` });
      assert.deepInclude(gone, { status: 404, _tag: 'ModelNotFound' });
    }),
  );

  it.effect("a model or projector outside the models folder and no profile's is a 403 on every tuning endpoint", () =>
    Effect.gen(function* () {
      yield* noBinary;
      const home = yield* Home;
      const good = yield* model('a.gguf');
      const outside = `${home}/elsewhere/b.gguf`;
      const refused = { status: 403, _tag: 'ModelPathRefused' };
      const cases = [
        { name: 'the model', files: { modelPath: outside } },
        { name: 'the projector', files: { modelPath: good, mmprojPath: outside } },
      ];
      for (const { name, files } of cases) {
        const estimate = yield* failure('POST', '/api/tuning/estimate', { ...files, preset: 'fit' });
        assert.deepInclude(estimate, refused, `estimate, ${name}`);
        const plan = yield* failure('POST', '/api/tuning/plan', { spec: sweepSpec(files) });
        assert.deepInclude(plan, refused, `plan, ${name}`);
      }
      const disk = yield* failure('POST', '/api/tuning/disk-speed', { modelPath: outside });
      assert.deepInclude(disk, refused);
      const checks = yield* failure('GET', `/api/tuning/checks?model=${encodeURIComponent(outside)}`);
      assert.deepInclude(checks, refused);
    }),
  );

  it.effect('the checks leave out a model that cannot be read, and take an empty model as none', () =>
    Effect.gen(function* () {
      yield* noBinary;
      const home = yield* Home;
      const fs = yield* FileSystem.FileSystem;
      yield* fs.makeDirectory(`${home}/models`);
      yield* fs.writeFileString(`${home}/models/bad.gguf`, 'not a gguf');
      for (const query of [`?model=${encodeURIComponent(`${home}/models/bad.gguf`)}`, '?model=', '']) {
        const report = yield* ok(ChecksReport, 'GET', `/api/tuning/checks${query}`);
        const { warn, ok: fine, unknown, na } = report.summary;
        assert.strictEqual(warn + fine + unknown + na, report.checks.length, query);
      }
    }),
  );

  it.effect('the estimate refuses a ctx out of [512, 10,000,000] and an unknown key', () =>
    Effect.gen(function* () {
      yield* noBinary;
      const path = yield* model('a.gguf');
      const bodies: ReadonlyArray<readonly [string, Record<string, unknown>, string]> = [
        ['ctx 511', { ctx: 511 }, 'ctx'],
        ['ctx 10,000,001', { ctx: 10_000_001 }, 'ctx'],
        ['ctx 1.5', { ctx: 1024.5 }, 'ctx'],
        ['an unknown key', { extra: 1 }, 'extra'],
        ['an unknown preset', { preset: 'huge' }, 'preset'],
      ];
      for (const [name, more, path_] of bodies) {
        const refused = yield* failure('POST', '/api/tuning/estimate', { modelPath: path, preset: 'fit', ...more });
        assert.deepStrictEqual([refused.status, refused._tag], [400, 'RequestInvalid'], name);
        assert.deepStrictEqual(refused.paths, [path_], name);
      }
      const bounds = yield* Effect.forEach([512, 10_000_000], (ctx) =>
        send('POST', '/api/tuning/estimate', { modelPath: path, preset: 'fit', ctx }),
      );
      assert.deepStrictEqual(
        Arr.map(bounds, (res) => res.status),
        [200, 200],
      );
    }),
  );

  it.effect('a plan without its spec is a 400 on the path spec; with one, its items', () =>
    Effect.gen(function* () {
      yield* noBinary;
      const refused = yield* failure('POST', '/api/tuning/plan', {});
      assert.deepStrictEqual([refused.status, refused._tag, refused.paths], [400, 'RequestInvalid', ['spec']]);
      const path = yield* model('a.gguf');
      const plan = yield* ok(PlanResult, 'POST', '/api/tuning/plan', {
        spec: sweepSpec({ modelPath: path, space: { t: [1, 2] }, includeUnfit: true }),
      });
      assert.deepStrictEqual(
        Arr.map(plan.items, (item) => item.params.t),
        [1, 2],
      );
    }),
  );
});
