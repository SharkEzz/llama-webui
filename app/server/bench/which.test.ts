import * as NodeServices from '@effect/platform-node/NodeServices';
import { assert, layer } from '@effect/vitest';
import { ConfigProvider, Effect, FileSystem, Option, Path } from 'effect';
import { which } from './which.ts';

layer(NodeServices.layer)('which', (it) => {
  it.effect('which looks the binary up in the PATH', () =>
    Effect.gen(function* () {
      const sh = yield* which('sh');
      assert.isTrue(Option.isSome(sh) && /^\/.*\/sh$/.test(sh.value));
      const missing = yield* which('no-such-bin-xyz');
      assert.deepStrictEqual(missing, Option.none());
      const direct = yield* which('/bin/sh');
      assert.deepStrictEqual(direct, Option.some('/bin/sh'));
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: 'lw-which-' });
      yield* fs.makeDirectory(path.join(dir, 'tool'));
      // A directory is not a binary.
      const folder = yield* which('tool').pipe(
        Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnv({ env: { PATH: dir } })),
      );
      assert.deepStrictEqual(folder, Option.none());
    }),
  );
});
