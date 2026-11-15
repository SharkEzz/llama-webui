import { assert, layer } from '@effect/vitest';
import type { ModelEntry } from '@llama-webui/shared';
import { Effect, Path } from 'effect';
import { findEntry } from './access.ts';

/** An entry the scan could not read: only its paths matter here. */
const entry = (path: string, files: ReadonlyArray<string> = [path]): ModelEntry => ({
  ok: false,
  path,
  relPath: path,
  files,
  fileBytes: 0,
  error: 'not read',
});

/** Whether `findEntry` refuses `path` with the 404 `Model not found`. */
const refused = Effect.fnUntraced(function* (models: ReadonlyArray<ModelEntry>, path: string) {
  const error = yield* Effect.flip(findEntry({ models, root: '/m', path }));
  assert.strictEqual(error._tag, 'ModelNotFound');
  assert.strictEqual(error.message, 'Model not found');
});

layer(Path.layer)('findEntry', (it) => {
  it.effect('a scanned entry under the models folder is found', () =>
    Effect.gen(function* () {
      const model = entry('/m/o/r/a.gguf');
      const found = yield* findEntry({ models: [model], root: '/m', path: '/m/o/r/a.gguf' });
      assert.strictEqual(found, model);
      // The root as typed, with a trailing slash or a `..`, is resolved.
      const resolved = yield* findEntry({ models: [model], root: '/m/../m/', path: '/m/o/r/a.gguf' });
      assert.strictEqual(resolved, model);
    }),
  );

  it.effect('an entry whose file is outside the models folder is refused, even when the scan listed it', () =>
    Effect.gen(function* () {
      // Outside: another folder, one that only starts like the root, the root itself, a `..` that climbs out.
      yield* refused([entry('/n/a.gguf')], '/n/a.gguf');
      yield* refused([entry('/models/a.gguf')], '/models/a.gguf');
      yield* refused([entry('/m')], '/m');
      yield* refused([entry('/m/../n/a.gguf')], '/m/../n/a.gguf');
      // A split model one of whose later shards is outside: refused whole.
      yield* refused(
        [entry('/m/a-00001-of-00002.gguf', ['/m/a-00001-of-00002.gguf', '/n/a-00002-of-00002.gguf'])],
        '/m/a-00001-of-00002.gguf',
      );
    }),
  );

  it.effect('a path the scan did not list is refused', () =>
    Effect.gen(function* () {
      yield* refused([entry('/m/o/r/a.gguf')], '/m/o/r/b.gguf');
      yield* refused([], '/m/o/r/a.gguf');
    }),
  );
});
