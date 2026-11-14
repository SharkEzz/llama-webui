import { NodeFileSystem } from '@effect/platform-node';
import { assert, describe, it, layer } from '@effect/vitest';
import { HF_REPO_RE, HfInvalidPath } from '@llama-webui/shared';
import { Effect, FileSystem, Option } from 'effect';
import { fileDest, partPath, repoDir, sizeOf } from './paths.ts';

/** Runs `effect` and checks what it succeeds with. */
const equals = <A, E, R>(effect: Effect.Effect<A, E, R>, expected: A) =>
  Effect.map(effect, (actual) => assert.deepStrictEqual(actual, expected));

describe('paths', () => {
  it.effect('downloads go to <modelsDir>/<org>/<name>', () =>
    Effect.gen(function* () {
      assert.strictEqual(repoDir('/m', 'unsloth/Qwen3-GGUF'), '/m/unsloth/Qwen3-GGUF');
      assert.strictEqual(repoDir('/m/', 'unsloth/Qwen3-GGUF'), '/m/unsloth/Qwen3-GGUF');
      yield* equals(fileDest('/m/o/r', 'Q4_K_M/a-00001-of-00002.gguf'), '/m/o/r/Q4_K_M/a-00001-of-00002.gguf');
      yield* equals(fileDest('/m/o/r', './a/../b.gguf'), '/m/o/r/b.gguf');
      assert.strictEqual(partPath('/m/o/r/b.gguf'), '/m/o/r/b.gguf.part');
    }),
  );

  it.effect('a path cannot leave the repo folder', () =>
    Effect.gen(function* () {
      // The repository id is checked before it makes a folder: no `..`.
      assert.isFalse(HF_REPO_RE.test('../x'));
      for (const path of ['../../etc/passwd', '/etc/passwd', '', 'a/..', 'a/../../r/x.gguf']) {
        yield* equals(
          Effect.flip(fileDest('/m/o/r', path)),
          HfInvalidPath.make({ message: `Invalid file path in the repository: ${path}` }),
        );
      }
    }),
  );
});

layer(NodeFileSystem.layer)('sizeOf', (it) => {
  it.effect('the size of a file, none for a missing one', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: 'lw-hf-paths-' });
      yield* fs.writeFileString(`${dir}/a.gguf`, 'abcd');
      yield* equals(sizeOf(`${dir}/a.gguf`), Option.some(4));
      yield* equals(sizeOf(`${dir}/b.gguf`), Option.none());
    }).pipe(Effect.scoped),
  );
});
