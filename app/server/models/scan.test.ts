import { NodeServices } from '@effect/platform-node';
import { assert, describe, it } from '@effect/vitest';
import { Array as Arr, Context, Effect, FileSystem, Layer, Option, Path, Ref, type Scope } from 'effect';
import * as Db from '../db/Db.ts';
import { type FakeTensor, type KvValue, writeGguf } from '../testing/gguf.ts';
import { GgufReader } from './GgufReader.ts';
import { ModelCacheRepo } from './ModelCacheRepo.ts';
import { groupGgufFiles, scanModels } from './scan.ts';

const str = (value: string): KvValue => ({ type: 'string', value });
const u32 = (value: number): KvValue => ({ type: 'u32', value });
const TENSORS: FakeTensor[] = [{ name: 'token_embd.weight', shape: [8, 4], bytes: 128 }];
const LLAMA = { 'general.architecture': str('llama'), 'llama.block_count': u32(1) };

/** How many GGUFs the scan read. */
class Reads extends Context.Service<Reads, Ref.Ref<number>>()('@llama-webui/app/server/models/scan.test/Reads') {}

/** The real reader, each read counted. */
const Counted = Layer.effect(
  GgufReader,
  Effect.gen(function* () {
    const real = yield* GgufReader;
    const reads = yield* Reads;
    return GgufReader.of({
      stamp: real.stamp,
      read: Effect.fn((path) => Ref.update(reads, (n) => n + 1).pipe(Effect.andThen(real.read(path)))),
    });
  }),
).pipe(Layer.provide(GgufReader.layer));

const Fresh = Layer.mergeAll(Counted, ModelCacheRepo.layer).pipe(
  Layer.provideMerge(Layer.effect(Reads, Ref.make(0))),
  Layer.provideMerge(Db.layerAt(':memory:')),
  Layer.provideMerge(NodeServices.layer),
);

type Services = GgufReader | ModelCacheRepo | Reads | FileSystem.FileSystem | Path.Path | Scope.Scope;

/** `test` on its own database and reader, in a scope closed at its end (its folders removed). */
const fresh = <A, E>(test: Effect.Effect<A, E, Services>) =>
  Layer.build(Fresh).pipe(
    Effect.flatMap((context) => Effect.provideContext(test, context)),
    Effect.scoped,
  );

/** A models folder of the test's own, and ways to fill it. */
const workspace = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: 'lw-scan-' });
  const at = (name: string) => path.join(root, name);
  /** Writes the GGUF `name` (its folders made) and gives its path. */
  const write = Effect.fnUntraced(function* (
    name: string,
    kv: Record<string, KvValue> = LLAMA,
    tensors: FakeTensor[] = TENSORS,
  ) {
    yield* fs.makeDirectory(path.dirname(at(name)), { recursive: true });
    yield* Effect.promise(() => writeGguf(at(name), kv, tensors));
    return at(name);
  });
  /** The reads counted so far, and the counter reset. */
  const takeReads = Effect.gen(function* () {
    const reads = yield* Reads;
    return yield* Ref.getAndSet(reads, 0);
  });
  return { fs, root, at, write, takeReads };
});

describe('scan', () => {
  it('groupGgufFiles groups shards under the first and reports missing ones', () => {
    assert.deepStrictEqual(groupGgufFiles(['a/Big-00002-of-00003.gguf', 'small.gguf', 'a/Big-00001-of-00003.gguf']), [
      {
        main: 'a/Big-00001-of-00003.gguf',
        files: ['a/Big-00001-of-00003.gguf', 'a/Big-00002-of-00003.gguf'],
        missing: ['a/Big-00003-of-00003.gguf'],
      },
      { main: 'small.gguf', files: ['small.gguf'], missing: [] },
    ]);
  });

  it.effect('scanModels skips hidden dirs, classifies mmproj, reports unreadable files and reuses the cache', () =>
    fresh(
      Effect.gen(function* () {
        const { fs, root, at, write, takeReads } = yield* workspace;
        yield* write('model.gguf');
        yield* write('mm.gguf', { 'general.architecture': str('clip'), 'general.type': str('mmproj') });
        yield* write('.cache/x.gguf', { 'general.architecture': str('llama') });
        yield* write('.hidden.gguf');
        yield* fs.writeFileString(at('bad.gguf'), 'not a gguf');
        yield* fs.writeFileString(at('notes.txt'), 'nothing');

        const first = yield* scanModels(root);
        const firstReads = yield* takeReads;
        assert.strictEqual(firstReads, 3);
        assert.deepStrictEqual(
          Arr.map(first, (e) => [e.relPath, e.ok, e.ok ? e.kind : null]),
          [
            ['bad.gguf', false, null],
            ['mm.gguf', true, 'mmproj'],
            ['model.gguf', true, 'model'],
          ],
        );
        const bad = first[0]!;
        assert.match(bad.ok ? '' : bad.error, /^unreadable GGUF: /);
        assert.deepStrictEqual([bad.path, bad.files, bad.fileBytes], [at('bad.gguf'), [at('bad.gguf')], 10]);

        const second = yield* scanModels(root);
        const secondReads = yield* takeReads;
        assert.strictEqual(secondReads, 1);
        assert.deepStrictEqual(second, first);
      }),
    ),
  );

  it.effect('scanModels follows a .gguf symlink to a regular file but not a directory symlink', () =>
    fresh(
      Effect.gen(function* () {
        const { fs, root, at, write } = yield* workspace;
        const elsewhere = yield* fs.makeTempDirectoryScoped({ prefix: 'lw-scan-out-' });
        const target = `${elsewhere}/target.gguf`;
        yield* Effect.promise(() => writeGguf(target, LLAMA, TENSORS));
        yield* fs.makeDirectory(`${elsewhere}/folder`);
        yield* Effect.promise(() => writeGguf(`${elsewhere}/folder/inner.gguf`, LLAMA, TENSORS));
        yield* write('own.gguf');
        yield* fs.symlink(target, at('linked.gguf'));
        yield* fs.symlink(`${elsewhere}/folder`, at('dirlink'));
        yield* fs.symlink(`${elsewhere}/folder`, at('folder.gguf'));
        yield* fs.symlink(`${elsewhere}/gone.gguf`, at('dangling.gguf'));

        const entries = yield* scanModels(root);
        assert.deepStrictEqual(
          Arr.map(entries, (e) => [e.relPath, e.ok]),
          [
            ['linked.gguf', true],
            ['own.gguf', true],
          ],
        );
        assert.strictEqual(entries[0]!.path, at('linked.gguf'));
      }),
    ),
  );

  it.effect('scanModels reports an incomplete shard set as missing shard', () =>
    fresh(
      Effect.gen(function* () {
        const { fs, root, write, takeReads } = yield* workspace;
        const p1 = yield* write('sub/big-00001-of-00003.gguf');
        const size = Number((yield* fs.stat(p1)).size);
        const entries = yield* scanModels(root);
        assert.deepStrictEqual(entries, [
          {
            ok: false,
            path: p1,
            relPath: 'sub/big-00001-of-00003.gguf',
            files: [p1],
            fileBytes: size,
            error: 'missing shard: big-00002-of-00003.gguf, big-00003-of-00003.gguf',
          },
        ]);
        const reads = yield* takeReads;
        assert.strictEqual(reads, 0);
      }),
    ),
  );

  it.effect('scanModels prunes the cache rows of vanished files', () =>
    fresh(
      Effect.gen(function* () {
        const { fs, root, write } = yield* workspace;
        const a = yield* write('a.gguf');
        const b = yield* write('b.gguf');
        const old = '/elsewhere/old.gguf';
        yield* scanModels(root);
        const repo = yield* ModelCacheRepo;
        const row = yield* repo.get(a);
        assert.isTrue(Option.isSome(row));
        if (Option.isSome(row)) yield* repo.put(old, '1:1', { ...row.value.summary, path: old });
        const before = yield* cached([a, b, old]);
        assert.deepStrictEqual(before, [true, true, true]);
        yield* fs.remove(b);
        const entries = yield* scanModels(root);
        assert.deepStrictEqual(
          Arr.map(entries, (e) => e.relPath),
          ['a.gguf'],
        );
        const after = yield* cached([a, b, old]);
        assert.deepStrictEqual(after, [true, false, false]);
      }),
    ),
  );

  it.effect('scanModels never caches a failed read', () =>
    fresh(
      Effect.gen(function* () {
        const { fs, root, at, takeReads } = yield* workspace;
        yield* fs.writeFileString(at('bad.gguf'), 'not a gguf');
        const first = yield* scanModels(root);
        assert.isFalse(first[0]!.ok);
        const rows = yield* cached([at('bad.gguf')]);
        assert.deepStrictEqual(rows, [false]);
        yield* scanModels(root);
        const reads = yield* takeReads;
        assert.strictEqual(reads, 2);
      }),
    ),
  );

  it.effect.skipIf(process.getuid?.() === 0)('scanModels skips a folder it cannot read', () =>
    fresh(
      Effect.gen(function* () {
        const { fs, root, at, write } = yield* workspace;
        yield* write('ok.gguf');
        yield* write('locked/m.gguf');
        yield* fs.chmod(at('locked'), 0o000);
        const entries = yield* scanModels(root).pipe(Effect.ensuring(Effect.orDie(fs.chmod(at('locked'), 0o755))));
        assert.deepStrictEqual(
          Arr.map(entries, (e) => e.relPath),
          ['ok.gguf'],
        );
      }),
    ),
  );

  it.effect('a missing models folder scans as empty', () =>
    fresh(
      Effect.gen(function* () {
        const { fs, root, at } = yield* workspace;
        yield* fs.writeFileString(at('plain'), 'a file, not a folder');
        const scans = yield* Effect.forEach([at('nope'), at('plain'), `${root}/nope/deeper`], scanModels);
        assert.deepStrictEqual(scans, [[], [], []]);
      }),
    ),
  );
});

/** Whether `model_cache` has a row for each path. */
const cached = Effect.fnUntraced(function* (paths: ReadonlyArray<string>) {
  const repo = yield* ModelCacheRepo;
  return yield* Effect.forEach(paths, (path) => repo.get(path).pipe(Effect.map(Option.isSome)));
});
