import { assert, describe, it } from '@effect/vitest';
import { Array as Arr, Effect, Exit, Layer, Option, String as Str } from 'effect';
import { SqlClient } from 'effect/sql';
import { TestClock } from 'effect/testing';
import * as Db from '../db/Db.ts';
import type { NewDownload } from '../hf/repo.ts';
import { DownloadsRepo } from './DownloadsRepo.ts';

/** A repository on a new in-memory database, with its client for what the test stores itself. */
const Fresh = DownloadsRepo.layer.pipe(Layer.provideMerge(Db.layerAt(':memory:')));

/** `test` on its own new database, on the `TestClock`. */
const fresh = <A, E>(test: Effect.Effect<A, E, DownloadsRepo | SqlClient.SqlClient>) =>
  Layer.build(Fresh).pipe(
    Effect.flatMap((context) => Effect.provideContext(test, context)),
    Effect.scoped,
  );

const SHA = Str.repeat(40)('a');
const SHA256 = Str.repeat(64)('f');

/** A variant of `o/r` whose files are `paths`, each `size` bytes. */
const input = (key: string, paths: ReadonlyArray<string> = [key], size = 100): NewDownload => ({
  repo: 'o/r',
  revision: SHA,
  key,
  name: Str.replace(/\.gguf$/, '')(key),
  quant: null,
  kind: 'model',
  dir: '/models/o/r',
  files: Arr.map(paths, (path) => ({ path, size, sha256: null })),
});

describe('DownloadsRepo', () => {
  it.effect('create, get and list by id', () =>
    fresh(
      Effect.gen(function* () {
        const repo = yield* DownloadsRepo;
        yield* TestClock.adjust('1000 millis');
        const a = yield* repo.create(input('a.gguf', ['a-1.gguf', 'a-2.gguf'], 300));
        assert.deepStrictEqual(a, {
          id: a.id,
          repo: 'o/r',
          revision: SHA,
          key: 'a.gguf',
          name: 'a',
          quant: null,
          kind: 'model',
          dir: '/models/o/r',
          files: [
            { path: 'a-1.gguf', size: 300, sha256: null, done: false },
            { path: 'a-2.gguf', size: 300, sha256: null, done: false },
          ],
          status: 'queued',
          bytesDone: 0,
          totalBytes: 600,
          error: null,
          code: null,
          createdAt: 1000,
          finishedAt: null,
        });
        const b = yield* repo.create({ ...input('b.gguf'), quant: 'Q4_K_M', kind: 'mmproj' });
        const gotA = yield* repo.get(a.id);
        assert.deepStrictEqual(gotA, Option.some(a));
        const missing = yield* repo.get(b.id + 1);
        assert.deepStrictEqual(missing, Option.none());
        const list = yield* repo.list;
        assert.deepStrictEqual(
          Arr.map(list, (item) => [item.id, item.key, item.quant, item.kind]),
          [
            [a.id, 'a.gguf', null, 'model'],
            [b.id, 'b.gguf', 'Q4_K_M', 'mmproj'],
          ],
        );
        assert.isTrue(a.id < b.id);
      }),
    ),
  );

  it.effect('createAll writes every row in one transaction: one that cannot be written leaves none', () =>
    fresh(
      Effect.gen(function* () {
        const repo = yield* DownloadsRepo;
        const made = yield* repo.createAll([input('a.gguf'), input('b.gguf')]);
        assert.deepStrictEqual(
          Arr.map(made, (item) => item.key),
          ['a.gguf', 'b.gguf'],
        );
        // The second row's files do not encode (a size that is not an integer): the first is rolled back with it.
        const exit = yield* Effect.exit(repo.createAll([input('c.gguf'), input('d.gguf', ['d.gguf'], 1.5)]));
        assert.isTrue(Exit.hasDies(exit));
        const list = yield* repo.list;
        assert.deepStrictEqual(
          Arr.map(list, (item) => item.key),
          ['a.gguf', 'b.gguf'],
        );
      }),
    ),
  );

  it.effect('next takes an item left downloading first, then the oldest queued', () =>
    fresh(
      Effect.gen(function* () {
        const repo = yield* DownloadsRepo;
        const nextId = Effect.map(
          repo.next,
          Option.map((item) => item.id),
        );
        const empty = yield* repo.next;
        assert.deepStrictEqual(empty, Option.none());
        const a = yield* repo.create(input('a.gguf'));
        const b = yield* repo.create(input('b.gguf'));
        const c = yield* repo.create(input('c.gguf'));
        const nextA = yield* nextId;
        assert.deepStrictEqual(nextA, Option.some(a.id));
        yield* repo.setStatus(c.id, 'downloading');
        const nextC = yield* nextId;
        assert.deepStrictEqual(nextC, Option.some(c.id));
        yield* repo.setStatus(c.id, 'done');
        yield* repo.setStatus(a.id, 'error', { error: 'boom', code: 'download-failed' });
        const nextB = yield* nextId;
        assert.deepStrictEqual(nextB, Option.some(b.id));
        const active = yield* repo.active;
        assert.deepStrictEqual(
          Arr.map(active, (item) => item.id),
          [b.id],
        );
        yield* repo.setStatus(b.id, 'canceled');
        const none = yield* repo.next;
        assert.deepStrictEqual(none, Option.none());
      }),
    ),
  );

  it.effect("fileDone adds the file's size to bytesDone", () =>
    fresh(
      Effect.gen(function* () {
        const repo = yield* DownloadsRepo;
        const item = yield* repo.create({
          ...input('m.gguf'),
          files: [
            { path: 'm-1.gguf', size: 300, sha256: Str.repeat(64)('x') },
            { path: 'm-2.gguf', size: 200, sha256: null },
          ],
        });
        const first = yield* repo.fileDone(item.id, 'm-2.gguf');
        assert.deepStrictEqual([first.bytesDone, Arr.map(first.files, (file) => file.done)], [200, [false, true]]);
        const second = yield* repo.fileDone(item.id, 'm-1.gguf');
        assert.deepStrictEqual([second.bytesDone, Arr.map(second.files, (file) => file.done)], [500, [true, true]]);
        // Marked twice, counted once.
        const again = yield* repo.fileDone(item.id, 'm-1.gguf');
        assert.strictEqual(again.bytesDone, 500);
        const stored = yield* repo.get(item.id);
        assert.deepStrictEqual(stored, Option.some(again));
      }),
    ),
  );

  it.effect('requeue marks every file not done and clears the error, code and finishedAt', () =>
    fresh(
      Effect.gen(function* () {
        const repo = yield* DownloadsRepo;
        const item = yield* repo.create(input('m.gguf', ['m-1.gguf', 'm-2.gguf']));
        yield* repo.fileDone(item.id, 'm-1.gguf');
        yield* TestClock.adjust('5000 millis');
        const failed = yield* repo.setStatus(item.id, 'error', { error: 'Disk full', code: 'disk-full' });
        assert.deepStrictEqual(
          [failed.status, failed.error, failed.code, failed.finishedAt, failed.bytesDone],
          ['error', 'Disk full', 'disk-full', 5000, 100],
        );
        const queued = yield* repo.requeue(item.id);
        assert.deepStrictEqual(
          [queued.status, queued.error, queued.code, queued.finishedAt, queued.bytesDone],
          ['queued', null, null, null, 0],
        );
        assert.deepStrictEqual(
          Arr.map(queued.files, (file) => file.done),
          [false, false],
        );
        // A status that is not final has no finishedAt.
        const running = yield* repo.setStatus(item.id, 'downloading');
        assert.strictEqual(running.finishedAt, null);
      }),
    ),
  );

  it.effect('clearFinished deletes done, error and canceled rows and returns their ids', () =>
    fresh(
      Effect.gen(function* () {
        const repo = yield* DownloadsRepo;
        const idOf = (key: string) => Effect.map(repo.create(input(`${key}.gguf`)), (item) => item.id);
        const a = yield* idOf('a');
        const b = yield* idOf('b');
        const c = yield* idOf('c');
        const d = yield* idOf('d');
        const e = yield* idOf('e');
        yield* repo.setStatus(e, 'canceled');
        yield* repo.setStatus(a, 'done');
        yield* repo.setStatus(c, 'error', { error: 'boom' });
        yield* repo.setStatus(d, 'downloading');
        const ids = Effect.map(
          repo.list,
          Arr.map((item) => item.id),
        );
        const cleared = yield* repo.clearFinished;
        assert.deepStrictEqual(cleared, [a, c, e]);
        const left = yield* ids;
        assert.deepStrictEqual(left, [b, d]);
        const again = yield* repo.clearFinished;
        assert.deepStrictEqual(again, []);
        yield* repo.remove(b);
        const last = yield* ids;
        assert.deepStrictEqual(last, [d]);
      }),
    ),
  );

  it.effect('a row written by the Nitro server reads back', () =>
    fresh(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const repo = yield* DownloadsRepo;
        // As `DownloadsRepo.create` and `fileDone` of the Nitro server wrote it.
        const files = `[{"path":"Q8/m-00001-of-00002.gguf","size":3000,"sha256":"${SHA256}","done":true},{"path":"Q8/m-00002-of-00002.gguf","size":2000,"sha256":null,"done":false}]`;
        yield* sql.unsafe(
          `INSERT INTO downloads(repo, revision, variant_key, name, quant, kind, dir, files_json, status, total_bytes, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)`,
          ['o/r', SHA, 'Q8/m-00001-of-00002.gguf', 'm-Q8', 'Q8_0', 'model', '/models/o/r', files, 5000, 1700000000000],
        );
        yield* sql.unsafe(
          `UPDATE downloads SET bytes_done = ?, status = ?, error = ?, code = ?, finished_at = ? WHERE id = 1`,
          [3000, 'error', 'Hugging Face unreachable', 'hf-unreachable', 1700000000500],
        );
        const item = yield* repo.get(1);
        assert.deepStrictEqual(
          item,
          Option.some({
            id: 1,
            repo: 'o/r',
            revision: SHA,
            key: 'Q8/m-00001-of-00002.gguf',
            name: 'm-Q8',
            quant: 'Q8_0',
            kind: 'model' as const,
            dir: '/models/o/r',
            files: [
              { path: 'Q8/m-00001-of-00002.gguf', size: 3000, sha256: SHA256, done: true },
              { path: 'Q8/m-00002-of-00002.gguf', size: 2000, sha256: null, done: false },
            ],
            status: 'error' as const,
            bytesDone: 3000,
            totalBytes: 5000,
            error: 'Hugging Face unreachable',
            code: 'hf-unreachable',
            createdAt: 1700000000000,
            finishedAt: 1700000000500,
          }),
        );
      }),
    ),
  );
});
