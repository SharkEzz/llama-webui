import { NodeServices } from '@effect/platform-node';
import { assert, describe, it } from '@effect/vitest';
import { Array as Arr, Effect, FileSystem, Layer, Path, type Scope, String as Str, Stream } from 'effect';
import { GgufReader } from '../models/GgufReader.ts';
import { type KvValue, writeGguf } from '../testing/gguf.ts';
import { fileRange, measureDiskSpeed } from './disk.ts';
import { loadModel, mmprojBytes } from './models.ts';

const Platform = GgufReader.layer.pipe(Layer.provideMerge(NodeServices.layer));

type Services = GgufReader | FileSystem.FileSystem | Path.Path | Scope.Scope;

const fresh = <A, E>(test: Effect.Effect<A, E, Services>) =>
  Layer.build(Platform).pipe(
    Effect.flatMap((context) => Effect.provideContext(test, context)),
    Effect.scoped,
  );

const str = (value: string): KvValue => ({ type: 'string', value });
const u32 = (value: number): KvValue => ({ type: 'u32', value });

/** A folder of the test's own. */
const workspace = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = yield* fs.makeTempDirectoryScoped({ prefix: 'lw-tuning-' });
  return { fs, dir, at: (name: string) => path.join(dir, name) };
});

/** The tag and message of the error `effect` fails with. */
const failureOf = <A, E extends { readonly _tag: string; readonly message: string }, R>(
  effect: Effect.Effect<A, E, R>,
) => Effect.map(Effect.flip(effect), (error): ReadonlyArray<string> => [error._tag, error.message]);

const MiB = 1024 ** 2;

describe('tuning reads', () => {
  it.effect('loadModel refuses a relative or non-.gguf path, a missing file, and an unreadable header', () =>
    fresh(
      Effect.gen(function* () {
        const { fs, at } = yield* workspace;
        yield* fs.makeDirectory(at('dir.gguf'));
        yield* fs.writeFileString(at('bad.gguf'), 'not a gguf');
        const failures = yield* Effect.all(
          Arr.map(['model.gguf', at('model.bin'), at('missing.gguf'), at('dir.gguf')], (p) => failureOf(loadModel(p))),
        );
        const invalid = ['ModelPathInvalid', 'Expected an absolute path to a .gguf file'];
        const missing = ['ModelNotFound', 'Model not found'];
        assert.deepStrictEqual(failures, [invalid, invalid, missing, missing]);
        const [bad] = yield* failureOf(loadModel(at('bad.gguf')));
        assert.strictEqual(bad, 'ModelUnreadable');
        yield* Effect.promise(() =>
          writeGguf(at('ok.gguf'), { 'general.architecture': str('llama'), 'llama.block_count': u32(1) }, [
            { name: 'token_embd.weight', shape: [8, 4], bytes: 128 },
          ]),
        );
        const model = yield* loadModel(at('ok.gguf'));
        assert.strictEqual(model.arch, 'llama');
      }),
    ),
  );

  it.effect('mmprojBytes is 0 without a projector, its size, or ProjectorNotFound', () =>
    fresh(
      Effect.gen(function* () {
        const { fs, at } = yield* workspace;
        yield* fs.writeFileString(at('mm.gguf'), Str.repeat(42)('x'));
        const sizes = yield* Effect.all(Arr.map([null, undefined, '', at('mm.gguf')], mmprojBytes));
        assert.deepStrictEqual(sizes, [0, 0, 0, 42]);
        const failure = yield* failureOf(mmprojBytes(at('none.gguf')));
        assert.deepStrictEqual(failure, ['ProjectorNotFound', 'Projector not found']);
      }),
    ),
  );

  it.effect('fileRange reads [start, end)', () =>
    fresh(
      Effect.gen(function* () {
        const { fs, at } = yield* workspace;
        yield* fs.writeFileString(at('f'), '0123456789');
        const text = yield* fileRange({ path: at('f'), start: 2, end: 5 }).pipe(Stream.decodeText(), Stream.mkString);
        assert.strictEqual(text, '234');
        const empty = yield* fileRange({ path: at('f'), start: 5, end: 5 }).pipe(Stream.decodeText(), Stream.mkString);
        assert.strictEqual(empty, '');
      }),
    ),
  );

  it.effect('fileRange reads in 1 MiB chunks, so the disk measure is not held back by the stream', () =>
    fresh(
      Effect.gen(function* () {
        const { fs, at } = yield* workspace;
        yield* fs.writeFile(at('f'), new Uint8Array(3 * MiB + 10));
        const chunks = yield* fileRange({ path: at('f'), start: 10, end: 3 * MiB + 10 }).pipe(Stream.runCollect);
        const sizes = Arr.map(Arr.fromIterable(chunks), (chunk) => chunk.byteLength);
        assert.deepStrictEqual(sizes, [MiB, MiB, MiB]);
      }),
    ),
  );

  it.effect('measureDiskSpeed: a missing path or a directory is a 404, a small file a 400', () =>
    fresh(
      Effect.gen(function* () {
        const { fs, dir, at } = yield* workspace;
        yield* fs.writeFileString(at('small.gguf'), Str.repeat(1024)('x'));
        const failures = yield* Effect.all(
          Arr.map([at('missing.gguf'), dir, at('small.gguf')], (path) => failureOf(measureDiskSpeed({ path }))),
        );
        assert.deepStrictEqual(failures, [
          ['ModelFileNotFound', `File not found: ${at('missing.gguf')}`],
          ['ModelFileNotFound', `File not found: ${dir}`],
          ['FileTooSmall', 'File too small to measure (0 MiB)'],
        ]);
      }),
    ),
  );

  it.live('measureDiskSpeed reads the requested bytes and times them', () =>
    fresh(
      Effect.gen(function* () {
        const { fs, at } = yield* workspace;
        const path = at('model.gguf');
        yield* fs.writeFile(path, new Uint8Array(65 * MiB));
        const speed = yield* measureDiskSpeed({ path, offsetFraction: 0 });
        assert.strictEqual(speed.sampledBytes, 65 * MiB);
        assert.strictEqual(speed.path, path);
        assert.isAbove(speed.bytesPerSec, 0);
        assert.isAbove(speed.at, 0);
      }),
    ),
  );
});
