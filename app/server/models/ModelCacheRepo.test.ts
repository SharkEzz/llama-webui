import { assert, describe, it } from '@effect/vitest';
import type { ModelSummary } from '@llama-webui/shared';
import { Array as Arr, Effect, Layer, Option, Schema } from 'effect';
import { SqlClient } from 'effect/sql';
import { TestClock } from 'effect/testing';
import * as Db from '../db/Db.ts';
import { ModelCacheRepo } from './ModelCacheRepo.ts';

/** A repository on a new in-memory database, with its client for what the test stores itself. */
const Fresh = ModelCacheRepo.layer.pipe(Layer.provideMerge(Db.layerAt(':memory:')));

/** `test` on its own new database. */
const fresh = <A, E>(test: Effect.Effect<A, E, ModelCacheRepo | SqlClient.SqlClient>) =>
  Layer.build(Fresh).pipe(
    Effect.flatMap((context) => Effect.provideContext(test, context)),
    Effect.scoped,
  );

const summary = (path: string): ModelSummary => ({
  path,
  relPath: 'm.gguf',
  files: [path],
  fileBytes: 1234,
  kind: 'model',
  arch: 'llama',
  name: 'Tiny',
  quant: 'Q4_K_M',
  params: 7_000_000,
  blockCount: 2,
  contextLength: 4096,
  embeddingLength: 64,
  headCount: 4,
  headCountKv: 2,
  expertCount: 0,
  expertUsedCount: 0,
  nextnLayers: 0,
  recurrent: false,
  slidingWindow: null,
  hasChatTemplate: true,
});

const Rows = Schema.Array(Schema.Struct({ path: Schema.String, read_at: Schema.Int }));

describe('ModelCacheRepo', () => {
  it.effect('put then get returns the summary and its stamp', () =>
    fresh(
      Effect.gen(function* () {
        const repo = yield* ModelCacheRepo;
        const none = yield* repo.get('/m/a.gguf');
        assert.deepStrictEqual(none, Option.none());
        yield* TestClock.adjust('1234 millis');
        yield* repo.put('/m/a.gguf', '1700000000000:1234', summary('/m/a.gguf'));
        const got = yield* repo.get('/m/a.gguf');
        assert.deepStrictEqual(got, Option.some({ stamp: '1700000000000:1234', summary: summary('/m/a.gguf') }));
        // A second put replaces the row.
        yield* repo.put('/m/a.gguf', '1700000000001:1234', { ...summary('/m/a.gguf'), name: 'Other' });
        const again = yield* repo.get('/m/a.gguf');
        assert.deepStrictEqual(
          Option.map(again, (row) => [row.stamp, row.summary.name]),
          Option.some(['1700000000001:1234', 'Other']),
        );
        const sql = yield* SqlClient.SqlClient;
        const raw = yield* sql`SELECT path, read_at FROM model_cache`;
        const rows = yield* Schema.decodeUnknownEffect(Rows)(raw);
        assert.deepStrictEqual(rows, [{ path: '/m/a.gguf', read_at: 1234 }]);
      }),
    ),
  );

  it.effect('a row written by the Nitro server reads back', () =>
    fresh(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        // As the Nitro server wrote it: `JSON.stringify` of the summary, and `mtimeMs` with its fraction.
        const json =
          '{"path":"/m/n.gguf","relPath":"n.gguf","files":["/m/n.gguf"],"fileBytes":1234,"kind":"model",' +
          '"arch":"llama","name":"Tiny","quant":"Q4_K_M","params":7000000,"blockCount":2,"contextLength":4096,' +
          '"embeddingLength":64,"headCount":4,"headCountKv":2,"expertCount":0,"expertUsedCount":0,"nextnLayers":0,' +
          '"recurrent":false,"slidingWindow":null,"hasChatTemplate":true}';
        yield* sql`INSERT INTO model_cache(path, stamp, summary_json, read_at)
          VALUES ('/m/n.gguf', '1731600000123.4567:1234', ${json}, 1731600000999)`;
        const repo = yield* ModelCacheRepo;
        const got = yield* repo.get('/m/n.gguf');
        assert.deepStrictEqual(
          got,
          Option.some({
            stamp: '1731600000123.4567:1234',
            summary: { ...summary('/m/n.gguf'), relPath: 'n.gguf' },
          }),
        );
      }),
    ),
  );

  it.effect('a row that no longer decodes is a miss', () =>
    fresh(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO model_cache(path, stamp, summary_json, read_at) VALUES
          ('/m/old.gguf', '1:1', '{"path":"/m/old.gguf","kind":"vision"}', 1),
          ('/m/broken.gguf', '1:1', 'not json', 1)`;
        const repo = yield* ModelCacheRepo;
        const got = yield* Effect.forEach(['/m/old.gguf', '/m/broken.gguf'], (path) => repo.get(path));
        assert.deepStrictEqual(got, [Option.none(), Option.none()]);
        // The next put replaces it.
        yield* repo.put('/m/old.gguf', '2:2', summary('/m/old.gguf'));
        const replaced = yield* repo.get('/m/old.gguf');
        assert.isTrue(Option.isSome(replaced));
      }),
    ),
  );

  it.effect('prune deletes the rows of the paths not kept and counts them', () =>
    fresh(
      Effect.gen(function* () {
        const repo = yield* ModelCacheRepo;
        const paths = ['/m/a.gguf', '/m/b.gguf', "/m/it's.gguf", '/m/d.gguf'];
        yield* Effect.forEach(paths, (path) => repo.put(path, '1:1', summary(path)));
        const pruned = yield* repo.prune(['/m/b.gguf', "/m/it's.gguf", '/m/never.gguf']);
        assert.strictEqual(pruned, 2);
        const kept = yield* Effect.forEach(paths, (path) => repo.get(path).pipe(Effect.map(Option.isSome)));
        assert.deepStrictEqual(kept, [false, true, true, false]);
        const again = yield* repo.prune(['/m/b.gguf', "/m/it's.gguf"]);
        assert.strictEqual(again, 0);
        const all = yield* repo.prune([]);
        assert.strictEqual(all, 2);
        const left = yield* Effect.forEach(paths, (path) => repo.get(path));
        assert.isTrue(Arr.every(left, Option.isNone));
      }),
    ),
  );
});
