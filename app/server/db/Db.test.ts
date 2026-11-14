import { NodeServices } from '@effect/platform-node';
import { SqliteClient } from '@effect/sql-sqlite-node';
import { assert, layer } from '@effect/vitest';
import { Context, Effect, FileSystem, Layer, Path } from 'effect';
import { SqlClient } from 'effect/sql';
import { AppConfig } from '../config/AppConfig.ts';
import * as Db from './Db.ts';

/** A copy of a fixture of `fixtures/` in a temporary folder (never the fixture itself), or a new file's path. */
const tempFile = Effect.fn('tempFile')(function* (fixture?: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = yield* fs.makeTempDirectoryScoped({ prefix: 'lw-db-' });
  const file = path.join(dir, 'llama-webui.sqlite');
  if (fixture !== undefined) yield* fs.copyFile(path.join(import.meta.dirname, 'fixtures', fixture), file);
  return file;
});

/** `f` on the SqlClient of `client`, closed after. */
const using = <A, E, E2, R>(
  client: Layer.Layer<SqlClient.SqlClient, E2, R>,
  f: (sql: SqlClient.SqlClient) => Effect.Effect<A, E>,
) => Layer.build(client).pipe(Effect.map(Context.get(SqlClient.SqlClient)), Effect.flatMap(f), Effect.scoped);

/** `f` on `filename` opened by the app. */
const withDb = <A, E>(filename: string, f: (sql: SqlClient.SqlClient) => Effect.Effect<A, E>) =>
  using(Db.layerAt(filename), f);

/** `f` on `filename` opened as it is: no migration, nothing recognised. */
const withRaw = <A, E>(filename: string, f: (sql: SqlClient.SqlClient) => Effect.Effect<A, E>) =>
  using(SqliteClient.layer({ filename }), f);

const schemaOf = (sql: SqlClient.SqlClient) =>
  sql`SELECT type, name, sql FROM sqlite_schema WHERE name != 'effect_sql_migrations' ORDER BY name`;

const rowsOf = (sql: SqlClient.SqlClient) =>
  Effect.all({
    settings: sql`SELECT * FROM settings ORDER BY key`,
    profiles: sql`SELECT * FROM profiles ORDER BY id`,
    conversations: sql`SELECT * FROM conversations ORDER BY id`,
    messages: sql`SELECT * FROM messages ORDER BY id`,
  });

const countsOf = (sql: SqlClient.SqlClient) =>
  Effect.all({
    migrations: sql`SELECT count(*) AS n FROM effect_sql_migrations`,
    schema: sql`SELECT count(*) AS n FROM sqlite_schema`,
  });

const insertProfile = (sql: SqlClient.SqlClient, name: string) =>
  sql<{
    readonly id: number;
  }>`INSERT INTO profiles(name, model_path, args_json, env_json, source, created_at, updated_at)
    VALUES (${name}, ${`/m/${name}.gguf`}, '[]', '{}', 'ui', 1, 1) RETURNING id`.pipe(
    Effect.map((rows) => rows[0]?.id ?? 0),
  );

layer(NodeServices.layer)('Db', (it) => {
  it.effect('a new database gets the schema of the Nitro server', () =>
    Effect.gen(function* () {
      const old = yield* tempFile('legacy-v17.sqlite');
      const legacy = yield* withRaw(old, schemaOf);
      const file = yield* tempFile();
      const fresh = yield* withDb(file, schemaOf);
      assert.deepStrictEqual(fresh, legacy);
    }),
  );

  it.effect('a database of the Nitro server is recognised: nothing is replayed and its rows are intact', () =>
    Effect.gen(function* () {
      const file = yield* tempFile('legacy-v17.sqlite');
      const before = yield* withRaw(file, rowsOf);
      const after = yield* withDb(file, (sql) =>
        Effect.all({ rows: rowsOf(sql), migrations: sql`SELECT migration_id, name FROM effect_sql_migrations` }),
      );
      assert.strictEqual(after.migrations.length, 17);
      assert.deepStrictEqual(after.migrations[16], { migration_id: 17, name: 'profiles_autoincrement' });
      assert.deepStrictEqual(after.rows, before);
      assert.strictEqual(before.profiles.length, 2);
      assert.strictEqual(before.messages.length, 2);
    }),
  );

  it.effect('an older database is brought up to date: profiles keep their ids and every link to them (#38)', () =>
    Effect.gen(function* () {
      const file = yield* tempFile('legacy-v16.sqlite');
      yield* withDb(file, (sql) =>
        Effect.gen(function* () {
          const version = yield* sql`SELECT version FROM schema_version`;
          assert.deepStrictEqual(version, [{ version: 17 }]);
          const profiles = yield* sql`SELECT id, name FROM profiles ORDER BY id`;
          assert.deepStrictEqual(profiles, [
            { id: 3, name: 'a' },
            { id: 7, name: 'b' },
            { id: 8, name: 'c' },
            { id: 9, name: 'e' },
          ]);
          const conversations = yield* sql`SELECT profile_id p FROM conversations`;
          assert.deepStrictEqual(conversations, [{ p: 7 }]);
          const sweeps = yield* sql`SELECT profile_id p FROM sweeps`;
          assert.deepStrictEqual(sweeps, [{ p: 3 }]);
          const runs = yield* sql`SELECT profile_id p FROM bench_runs`;
          assert.deepStrictEqual(runs, [{ p: 7 }]);
          const fk = yield* sql`PRAGMA foreign_keys`;
          assert.deepStrictEqual(fk, [{ foreign_keys: 1 }]);
          const violations = yield* sql`PRAGMA foreign_key_check`;
          assert.deepStrictEqual(violations, []);

          // The links still follow the profile: deleting it empties them, and its id is not reused.
          yield* sql`DELETE FROM profiles WHERE id = 7`;
          const emptied = yield* sql`SELECT profile_id p FROM conversations`;
          assert.deepStrictEqual(emptied, [{ p: null }]);
          const next = yield* insertProfile(sql, 'f');
          assert.strictEqual(next, 10);
        }),
      );
    }),
  );

  it.effect("a deleted profile's id is never given to a new profile (#38)", () =>
    Effect.gen(function* () {
      const file = yield* tempFile();
      yield* withDb(file, (sql) =>
        Effect.gen(function* () {
          yield* insertProfile(sql, 'a');
          const b = yield* insertProfile(sql, 'b');
          yield* sql`DELETE FROM profiles WHERE id = ${b}`;
          const c = yield* insertProfile(sql, 'c');
          assert.isAbove(c, b);
        }),
      );
    }),
  );

  it.effect('foreign keys are on once the database is open', () =>
    Effect.gen(function* () {
      const file = yield* tempFile();
      yield* withDb(file, (sql) =>
        Effect.gen(function* () {
          const fk = yield* sql`PRAGMA foreign_keys`;
          assert.deepStrictEqual(fk, [{ foreign_keys: 1 }]);
          const error = yield* sql`INSERT INTO messages(conversation_id, role, content, status, created_at)
            VALUES (999, 'user', 'x', 'done', 1)`.pipe(Effect.flip);
          assert.strictEqual(error.reason._tag, 'ConstraintError');
          assert.match(String(error.reason.cause), /FOREIGN KEY constraint failed/);
        }),
      );
    }),
  );

  it.effect('the database still opens with the Nitro server', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: 'lw-db-' });
      // A data directory that does not exist yet: opening creates it.
      const dataDir = path.join(root, 'a', 'llama-webui');
      const config = Layer.succeed(AppConfig, { host: '127.0.0.1', port: 1, dataDir, dev: false });
      yield* using(Db.layer.pipe(Layer.provide(config)), () => Effect.void);
      const version = yield* withRaw(
        path.join(dataDir, 'llama-webui.sqlite'),
        (sql) => sql`SELECT version FROM schema_version`,
      );
      assert.deepStrictEqual(version, [{ version: 17 }]);
    }),
  );

  it.effect('opening twice runs nothing the second time', () =>
    Effect.gen(function* () {
      const file = yield* tempFile();
      const first = yield* withDb(file, countsOf);
      const second = yield* withDb(file, countsOf);
      assert.deepStrictEqual(second, first);
      assert.deepStrictEqual(first.migrations, [{ n: 17 }]);
    }),
  );

  it.effect('a number bound to an INTEGER column is stored as an integer, a boolean as 1 or 0', () =>
    Effect.gen(function* () {
      const file = yield* tempFile();
      yield* withDb(file, (sql) =>
        Effect.gen(function* () {
          yield* sql`CREATE TEMP TABLE t(n INTEGER, b INTEGER, u)`;
          yield* sql`INSERT INTO t(n, b, u) VALUES (${3}, ${true}, ${3})`;
          const types = yield* sql`SELECT typeof(n) n, typeof(b) b, typeof(u) u, b AS v FROM t`;
          assert.deepStrictEqual(types, [{ n: 'integer', b: 'integer', u: 'real', v: 1 }]);
        }),
      );
    }),
  );
});
