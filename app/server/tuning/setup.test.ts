import { NodeServices } from '@effect/platform-node';
import { assert, describe, layer } from '@effect/vitest';
import { type GpuSample, LaunchpadEntry, SetupReport, type Snapshot } from '@llama-webui/shared';
import { Array as Arr, ConfigProvider, Context, Effect, FileSystem, Layer, Path, Schema } from 'effect';
import { HttpClient } from 'effect/http';
import { BenchHardware } from '../bench/BenchHardware.ts';
import { BenchRunsRepo } from '../bench/BenchRunsRepo.ts';
import * as Db from '../db/Db.ts';
import { ApiRoutes, serve } from '../http/HttpLive.ts';
import { GgufReader } from '../models/GgufReader.ts';
import { Monitor } from '../monitor/Monitor.ts';
import { ProfilesRepo } from '../profiles/ProfilesRepo.ts';
import { SettingsRepo } from '../settings/SettingsRepo.ts';
import { benchSpec, NO_HARDWARE } from '../testing/bench.ts';
import { type KvValue, writeGguf } from '../testing/gguf.ts';
import { ServerTest } from '../testing/http.ts';
import { ServicesTest } from '../testing/services.ts';
import { buildLaunchpad } from './setup.ts';
import { TuningHardware } from './TuningHardware.ts';

/** The home of the test (`HOME`, and `~/bin` the whole `PATH`): nothing of the user's is found or run. */
class Home extends Context.Service<Home, string>()('@llama-webui/app/server/tuning/setup.test/Home') {}

const HomeLive = Layer.effect(
  Home,
  Effect.flatMap(FileSystem.FileSystem, (fs) => fs.makeTempDirectoryScoped({ prefix: 'lw-setup-' })),
);

const homeConfig = ConfigProvider.layerAdd(
  Effect.map(Home, (home) => ConfigProvider.fromUnknown({ HOME: home, PATH: `${home}/bin` })),
  { asPrimary: true },
).pipe(Layer.provideMerge(HomeLive));

const served = serve(ApiRoutes).pipe(
  Layer.provideMerge(ServicesTest),
  Layer.provideMerge(ServerTest),
  Layer.provideMerge(homeConfig),
  Layer.provideMerge(NodeServices.layer),
);

const str = (value: string): KvValue => ({ type: 'string', value });
const u32 = (value: number): KvValue => ({ type: 'u32', value });

/** A small llama GGUF named `name` at `path` (its folder created). */
const writeModel = Effect.fnUntraced(function* (file: string, name: string, kv: Record<string, KvValue> = {}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(path.dirname(file), { recursive: true });
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
        { name: 'token_embd.weight', shape: [256, 64], bytes: 64 * 1024 },
        { name: 'blk.0.attn_q.weight', shape: [256, 256], bytes: 64 * 1024 },
        { name: 'blk.1.attn_q.weight', shape: [256, 256], bytes: 64 * 1024 },
        { name: 'output.weight', shape: [256, 64], bytes: 64 * 1024 },
      ],
    ),
  );
  const info = yield* fs.stat(file);
  return Number(info.size);
});

/** An executable shell script at `file` running `body`. */
const writeScript = Effect.fnUntraced(function* (file: string, body: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(path.dirname(file), { recursive: true });
  yield* fs.writeFileString(file, `#!/bin/sh\n${body}\n`);
  yield* fs.chmod(file, 0o755);
});

const FAKE_SERVER =
  'if [ "$1" = "--version" ]; then echo "version: 4242 (abc1234)" >&2; echo "built with cc for x86_64 (build 4242, commit abc1234)" >&2; fi';
const FAKE_BENCH = "printf 'Available devices:\\n  CUDA0: NVIDIA GeForce RTX 5070 Ti (15933 MiB, 15643 MiB free)\\n'";

const setup = Effect.gen(function* () {
  const client = yield* HttpClient.HttpClient;
  const res = yield* client.get('/api/setup');
  assert.strictEqual(res.status, 200);
  const json = yield* res.json;
  return yield* Schema.decodeUnknownEffect(SetupReport)(json);
});

const patch = Effect.fnUntraced(function* (change: Parameters<SettingsRepo['Service']['patch']>[0]) {
  const settings = yield* SettingsRepo;
  yield* settings.patch(change);
});

layer(served, { excludeTestServices: true, buildPerTest: true })('GET /api/setup', (it) => {
  it.effect('without a binary or a models folder, the report is not ready', () =>
    Effect.gen(function* () {
      const home = yield* Home;
      yield* patch({ binary: `${home}/bin/llama-server` });
      const report = yield* setup;
      assert.deepStrictEqual(report.binary, { setting: `${home}/bin/llama-server`, path: null, version: null });
      assert.deepStrictEqual(report.bench, { path: `${home}/bin/llama-bench`, devices: [] });
      assert.deepStrictEqual(report.models, {
        setting: '~/models',
        dir: `${home}/models`,
        exists: false,
        count: 0,
        bytes: 0,
      });
      assert.isFalse(report.ready);
    }),
  );

  it.effect('the setup report reads the version of a ~/… binary, and its llama-bench devices', () =>
    Effect.gen(function* () {
      const home = yield* Home;
      const fs = yield* FileSystem.FileSystem;
      yield* writeScript(`${home}/bin/llama-server`, FAKE_SERVER);
      yield* writeScript(`${home}/bin/llama-bench`, FAKE_BENCH);
      yield* fs.makeDirectory(`${home}/models`);
      yield* patch({ binary: '~/bin/llama-server' });
      const report = yield* setup;
      const real = yield* fs.realPath(`${home}/bin/llama-server`);
      assert.deepStrictEqual(report.binary, { setting: '~/bin/llama-server', path: real, version: 'b4242 (abc1234)' });
      assert.strictEqual(report.bench.path, `${home}/bin/llama-bench`);
      assert.deepStrictEqual(
        Arr.map(report.bench.devices, (d) => d.id),
        ['CUDA0'],
      );
      assert.deepInclude(report.models, { exists: true, count: 0, bytes: 0 });
      assert.isTrue(report.ready);
    }),
  );

  it.effect('a file without an execute bit, or a directory, is not a binary', () =>
    Effect.gen(function* () {
      const home = yield* Home;
      const fs = yield* FileSystem.FileSystem;
      yield* fs.makeDirectory(`${home}/bin`);
      yield* fs.writeFileString(`${home}/bin/plain`, 'x');
      yield* fs.chmod(`${home}/bin/plain`, 0o644);
      yield* fs.makeDirectory(`${home}/bin/dir`);
      for (const binary of [`${home}/bin/plain`, `${home}/bin/dir`, 'plain']) {
        yield* patch({ binary });
        const report = yield* setup;
        assert.isNull(report.binary.path, binary);
        assert.isNull(report.binary.version, binary);
      }
    }),
  );

  it.effect('the models folder counts the readable models only: no projector, no unreadable file', () =>
    Effect.gen(function* () {
      const home = yield* Home;
      const fs = yield* FileSystem.FileSystem;
      yield* patch({ binary: `${home}/bin/llama-server` });
      const a = yield* writeModel(`${home}/models/a.gguf`, 'A');
      const b = yield* writeModel(`${home}/models/sub/b.gguf`, 'B');
      yield* writeModel(`${home}/models/mmproj-a.gguf`, 'P', { 'general.type': str('mmproj') });
      yield* fs.writeFileString(`${home}/models/bad.gguf`, 'not a gguf');
      const report = yield* setup;
      assert.deepInclude(report.models, { exists: true, count: 2, bytes: a + b });
    }),
  );

  it.effect('llama-server is exposed on the network only when its host is not loopback (#27)', () =>
    Effect.gen(function* () {
      const home = yield* Home;
      yield* patch({ binary: `${home}/bin/llama-server` });
      const local = yield* setup;
      assert.deepStrictEqual(local.llamaListen, { host: '127.0.0.1', exposed: false });
      // Where llama-webui listens: the test server's 127.0.0.1.
      assert.deepStrictEqual(local.listen, { host: '127.0.0.1', exposed: false });
      yield* patch({ host: '0.0.0.0' });
      const lan = yield* setup;
      assert.deepStrictEqual(lan.llamaListen, { host: '0.0.0.0', exposed: true });
    }),
  );

  it.effect('the telemetry gives the NVIDIA source and perf_event_paranoid (an integer, or null)', () =>
    Effect.gen(function* () {
      const home = yield* Home;
      yield* patch({ binary: `${home}/bin/llama-server` });
      const { telemetry } = yield* setup;
      const monitor = yield* Monitor;
      const source = yield* monitor.nvidiaSource;
      assert.strictEqual(telemetry.nvidiaSource, source);
      assert.isTrue(telemetry.perfParanoid === null || Number.isInteger(telemetry.perfParanoid));
    }),
  );

  it.effect(
    'the launchpad gives each profile its model, fit and last bench; an unreadable model only sets modelError',
    () =>
      Effect.gen(function* () {
        const home = yield* Home;
        yield* patch({ binary: `${home}/bin/llama-server` });
        const bytes = yield* writeModel(`${home}/models/a.gguf`, 'A');
        const profiles = yield* ProfilesRepo;
        const one = yield* profiles.create({
          name: 'one',
          model: '~/models/a.gguf',
          args: ['-ngl', '99', '-c', '2048'],
          env: {},
        });
        const two = yield* profiles.create({ name: 'two', model: '~/models/gone.gguf', args: [], env: {} });
        const runs = yield* BenchRunsRepo;
        const run = yield* runs.create({
          spec: benchSpec({ profileId: one.id }),
          command: 'llama-bench',
          hardware: NO_HARDWARE,
          status: 'running',
        });
        const done = yield* runs.finish(run.id, { status: 'ok', pp: { tps: 900, stddev: 9, tokens: 512 } });

        const client = yield* HttpClient.HttpClient;
        const res = yield* client.get('/api/launchpad');
        assert.strictEqual(res.status, 200);
        const json = yield* res.json;
        const entries = yield* Schema.decodeUnknownEffect(Schema.Array(LaunchpadEntry))(json);
        const [first, second] = entries;
        assert.deepInclude(first, {
          profileId: one.id,
          name: 'one',
          modelPath: `${home}/models/a.gguf`,
          model: { name: 'A', quant: first?.model?.quant ?? '', fileBytes: bytes },
          modelError: null,
          lastBench: { ppTps: 900, tgTps: null, at: done.createdAt },
        });
        // No GPU anywhere: the estimate plans on the CPU, and gives its verdict.
        assert.isNotNull(first?.fit);
        assert.deepStrictEqual(second, {
          profileId: two.id,
          name: 'two',
          modelPath: `${home}/models/gone.gguf`,
          model: null,
          modelError: 'Model not found',
          lastBench: null,
          fit: null,
        });
      }),
  );
});

const MiB = 1024 ** 2;
const GiB = 1024 ** 3;

const GPU: GpuSample = {
  key: 'nvidia:a',
  vendor: 'nvidia',
  name: 'NVIDIA GeForce RTX 5070 Ti',
  busId: '0000:01:00.0',
  utilPct: 0,
  vramUsedBytes: GiB,
  vramTotalBytes: 15933 * MiB,
  tempC: null,
  powerW: null,
  procVramBytes: 0,
};

/** The stub monitor, with a last tick that sees `GPU`. */
const monitorWithGpu = Layer.effect(
  Monitor,
  Effect.map(Monitor, (stub) =>
    Monitor.of({
      ...stub,
      latest: Effect.succeed<Snapshot>({
        at: 0,
        tick: 1,
        health: null,
        rates: { genTps: 0, ppTps: 0 },
        slots: null,
        kv: null,
        queue: null,
        lastRequest: null,
        spec: null,
        recentRequests: [],
        gpus: [],
        allGpus: [GPU],
        proc: null,
        system: null,
        disk: null,
        points: {},
        history: { intervalMs: 1000, capacity: 0 },
      }),
    }),
  ),
).pipe(Layer.provide(Monitor.layerStub));

/** The launchpad's services on a new database, the monitor seeing a GPU, HOME the test's. */
const launchpadLayer = TuningHardware.layer.pipe(
  Layer.provideMerge(Layer.mergeAll(BenchHardware.layer, monitorWithGpu, GgufReader.layer)),
  Layer.provideMerge(Layer.mergeAll(SettingsRepo.layer, ProfilesRepo.layer, BenchRunsRepo.layer)),
  Layer.provideMerge(Db.layerAt(':memory:')),
  Layer.provideMerge(homeConfig),
  Layer.provideMerge(NodeServices.layer),
);

describe('buildLaunchpad', () => {
  layer(launchpadLayer, { excludeTestServices: true })('on a machine with a GPU', (it) => {
    it.effect('the fit is dropped when llama-bench sees no device but the monitor sees GPUs', () =>
      Effect.gen(function* () {
        const home = yield* Home;
        yield* patch({ binary: `${home}/bin/llama-server` });
        yield* writeModel(`${home}/models/a.gguf`, 'A');
        const profiles = yield* ProfilesRepo;
        yield* profiles.create({ name: 'one', model: `${home}/models/a.gguf`, args: [], env: {} });
        const [entry] = yield* buildLaunchpad;
        assert.strictEqual(entry?.modelError, null);
        assert.strictEqual(entry?.model?.name, 'A');
        assert.isNull(entry?.fit);
      }),
    );
  });
});
