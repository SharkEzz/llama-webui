import { NodeServices } from '@effect/platform-node';
import { assert, layer } from '@effect/vitest';
import { SetupReport } from '@llama-webui/shared';
import { Array as Arr, ConfigProvider, Context, Effect, FileSystem, Layer, Path, Schema } from 'effect';
import { HttpClient } from 'effect/http';
import { ApiRoutes, serve } from '../http/HttpLive.ts';
import { Monitor } from '../monitor/Monitor.ts';
import { SettingsRepo } from '../settings/SettingsRepo.ts';
import { type KvValue, writeGguf } from '../testing/gguf.ts';
import { ServerTest } from '../testing/http.ts';
import { ServicesTest } from '../testing/services.ts';

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
});
