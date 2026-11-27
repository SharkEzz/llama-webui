import * as NodeServices from '@effect/platform-node/NodeServices';
import { assert, layer } from '@effect/vitest';
import { Effect, FileSystem, Path, String as Str } from 'effect';
import { benchFailure } from './parse.ts';

layer(NodeServices.layer)('benchFailure', (it) => {
  it.effect('benchFailure reports an out-of-memory load', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const text = yield* fs.readFileString(
        path.resolve(import.meta.dirname, '../../../testdata/llama-bench/oom-stderr.txt'),
      );
      const failure = benchFailure({ lines: Str.split(text, '\n'), exit: 1 });
      assert.isTrue(failure.oom);
      assert.isTrue(Str.startsWith('Out of memory: ')(failure.message));
      assert.include(failure.message, 'unable to allocate CUDA1 buffer');
      assert.deepStrictEqual(benchFailure({ lines: ['nothing'], exit: 2 }), {
        oom: false,
        message: 'llama-bench exited (code 2)',
      });
    }),
  );
});
