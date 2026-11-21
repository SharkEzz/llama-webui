import { NodeServices } from '@effect/platform-node';
import { assert, layer } from '@effect/vitest';
import { Effect, FileSystem, Path } from 'effect';
import { freeBytesOf } from './freeSpace.ts';

/** What other programs may write to the disk between the two reads. */
const SLACK = 256 * 1024 * 1024;

layer(NodeServices.layer, { excludeTestServices: true })('freeBytesOf', (it) => {
  it.effect("the free space of a folder that does not exist yet is its nearest parent's", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: 'lw-free-' });
      const parent = yield* freeBytesOf(dir);
      const missing = yield* freeBytesOf(path.join(dir, 'org', 'repo', 'Q8_0'));
      assert.isNotNull(parent);
      assert.isNotNull(missing);
      assert.isAbove(parent ?? 0, 0);
      assert.isBelow(Math.abs((missing ?? 0) - (parent ?? 0)), SLACK);
    }).pipe(Effect.scoped),
  );
});
