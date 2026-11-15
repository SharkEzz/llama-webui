import { NodeServices } from '@effect/platform-node';
import { assert, layer } from '@effect/vitest';
import { HfNotFound, ListedTwice } from '@llama-webui/shared';
import { Array as Arr, ConfigProvider, Context, Effect, FileSystem, Layer, Path, String as Str } from 'effect';
import { type FakeHub, fakeHub } from '../testing/hub.ts';
import { ServicesTest } from '../testing/services.ts';
import { downloadInputs } from './repo.ts';

/** The home of the test (`HOME`): the models folder is the default `~/models` under it. */
class Home extends Context.Service<Home, string>()('@llama-webui/app/server/hf/repo.test/Home') {}

/** The fake Hub of the test. */
class Hub extends Context.Service<Hub, FakeHub>()('@llama-webui/app/server/hf/repo.test/Hub') {}

/** `org/repo`: a model in one file, one split in two, a projector. */
const FILES = {
  'Model-Q4_K_M.gguf': Str.repeat(30)('q'),
  'Q8_0/Model-Q8_0-00001-of-00002.gguf': Str.repeat(40)('1'),
  'Q8_0/Model-Q8_0-00002-of-00002.gguf': Str.repeat(40)('2'),
  'mmproj-F16.gguf': Str.repeat(5)('m'),
};

/** The services of the app with `HOME` a temporary folder, the fake Hub, no token. */
const Tested = ServicesTest.pipe(
  Layer.provideMerge(
    ConfigProvider.layerAdd(
      Effect.gen(function* () {
        const home = yield* Home;
        const hub = yield* Hub;
        return ConfigProvider.fromUnknown({
          HOME: home,
          HF_ENDPOINT: hub.url,
          HF_TOKEN: '',
          HUGGING_FACE_HUB_TOKEN: '',
          HF_TOKEN_PATH: `${home}/no-token`,
        });
      }),
      { asPrimary: true },
    ),
  ),
  Layer.provideMerge(
    Layer.mergeAll(
      Layer.effect(
        Home,
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          return yield* fs.makeTempDirectoryScoped({ prefix: 'lw-hf-repo-' });
        }),
      ),
      Layer.effect(Hub, fakeHub({ repos: [{ id: 'org/repo', files: FILES }] })),
    ),
  ),
  Layer.provideMerge(NodeServices.layer),
);

layer(Tested, { excludeTestServices: true, buildPerTest: true })('downloadInputs', (it) => {
  it.effect('the files left to write of each variant, at the pinned commit', () =>
    Effect.gen(function* () {
      const hub = yield* Hub;
      const home = yield* Home;
      const fs = yield* FileSystem.FileSystem;
      const paths = yield* Path.Path;
      const dir = paths.join(home, 'models', 'org', 'repo');
      // One shard of Q8_0 in place, the whole of Q4_K_M.
      yield* fs.makeDirectory(paths.join(dir, 'Q8_0'), { recursive: true });
      yield* fs.writeFileString(
        paths.join(dir, 'Q8_0/Model-Q8_0-00001-of-00002.gguf'),
        FILES['Q8_0/Model-Q8_0-00001-of-00002.gguf'],
      );
      yield* fs.writeFileString(paths.join(dir, 'Model-Q4_K_M.gguf'), FILES['Model-Q4_K_M.gguf']);
      const sha = hub.shaOf('org/repo');
      const inputs = yield* downloadInputs({
        repo: 'org/repo',
        revision: sha,
        keys: ['Q8_0/Model-Q8_0-00001-of-00002.gguf', 'Model-Q4_K_M.gguf', 'mmproj-F16.gguf'],
      });
      assert.deepStrictEqual(
        Arr.map(inputs, (input) => [input.repo, input.revision, input.key, input.kind, input.dir]),
        [
          ['org/repo', sha, 'Q8_0/Model-Q8_0-00001-of-00002.gguf', 'model', dir],
          ['org/repo', sha, 'mmproj-F16.gguf', 'mmproj', dir],
        ],
      );
      assert.deepStrictEqual(
        Arr.map(inputs, (input) => Arr.map(input.files, (file) => [file.path, file.size])),
        [[['Q8_0/Model-Q8_0-00002-of-00002.gguf', 40]], [['mmproj-F16.gguf', 5]]],
      );
      assert.deepStrictEqual(
        Arr.map(
          Arr.filter(hub.requests(), (r) => r.route === 'repo'),
          (r) => r.url,
        ),
        [`/api/models/org/repo/revision/${sha}?blobs=true`],
      );
    }),
  );

  it.effect('a key the repository does not have, or one given twice, is refused', () =>
    Effect.gen(function* () {
      const hub = yield* Hub;
      const revision = hub.shaOf('org/repo');
      const missing = yield* Effect.flip(
        downloadInputs({ repo: 'org/repo', revision, keys: ['Model-Q4_K_M.gguf', 'Model-F32.gguf'] }),
      );
      assert.deepStrictEqual(missing, HfNotFound.make({ message: 'No GGUF “Model-F32.gguf” in org/repo' }));
      const twice = yield* Effect.flip(
        downloadInputs({
          repo: 'org/repo',
          revision,
          keys: ['mmproj-F16.gguf', 'Model-Q4_K_M.gguf', 'mmproj-F16.gguf'],
        }),
      );
      assert.deepStrictEqual(twice, ListedTwice.make({ message: 'mmproj-F16 is listed twice' }));
    }),
  );
});
