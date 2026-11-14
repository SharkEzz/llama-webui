import { Array as Arr, Effect, Option, Record, String as Str } from 'effect';
import { SqlClient } from 'effect/sql';
import { MIGRATIONS } from './migrations.ts';

/** The table of `SqliteMigrator`, created as the migrator creates it (Effect 4.1.4, SQLite dialect). */
const MIGRATIONS_TABLE = `CREATE TABLE IF NOT EXISTS effect_sql_migrations (
  migration_id integer PRIMARY KEY NOT NULL,
  created_at datetime NOT NULL DEFAULT current_timestamp,
  name VARCHAR(255) NOT NULL
)`;

/** The migrations as the migrator records them: id and name of each `0001_<name>` key. */
const recorded = Arr.map(Record.keys(MIGRATIONS), (key) => {
  const [id, ...name] = Str.split(key, '_');
  return { migration_id: Number(id), name: Arr.join(name, '_') };
});

const tableExists = (name: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql`SELECT 1 AS found FROM sqlite_schema WHERE type = 'table' AND name = ${name}`;
    return Arr.isReadonlyArrayNonEmpty(rows);
  });

/**
 * A database of the Nitro server (a `schema_version` table, no `effect_sql_migrations`): the migrations it ran, 1 to
 * its `schema_version.version`, are recorded as run, so that the migrator replays none of them.
 */
export const recognise = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  if (!(yield* tableExists('schema_version')) || (yield* tableExists('effect_sql_migrations'))) return;
  const rows = yield* sql<{ readonly version: number }>`SELECT version FROM schema_version LIMIT 1`;
  const version = Option.match(Arr.head(rows), { onNone: () => 0, onSome: (row) => row.version });
  const done = Arr.filter(recorded, (m) => m.migration_id <= version);
  // Both or neither: a table without its rows would make the migrator replay migration 1 on every start.
  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* sql.unsafe(MIGRATIONS_TABLE);
      if (Arr.isArrayNonEmpty(done)) yield* sql`INSERT INTO effect_sql_migrations ${sql.insert(done)}`;
    }),
  );
  yield* Effect.logInfo(`database of the Nitro server recognised (schema version ${version})`);
}).pipe(Effect.withSpan('LegacyBridge.recognise'));

/**
 * The last migration run, written into `schema_version` (created if missing) as the Nitro server writes it: the
 * database still opens with the Nitro server, which runs only the migrations after it.
 */
export const keepSchemaVersion = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const last = yield* sql<{ readonly id: number | null }>`SELECT max(migration_id) AS id FROM effect_sql_migrations`;
  const version = Option.match(Arr.head(last), { onNone: () => 0, onSome: (row) => row.id ?? 0 });
  yield* sql`CREATE TABLE IF NOT EXISTS schema_version(version INTEGER NOT NULL)`;
  const rows = yield* sql`SELECT 1 AS found FROM schema_version LIMIT 1`;
  yield* Arr.isReadonlyArrayNonEmpty(rows)
    ? sql`UPDATE schema_version SET version = ${version}`
    : sql`INSERT INTO schema_version(version) VALUES (${version})`;
}).pipe(Effect.withSpan('LegacyBridge.keepSchemaVersion'));
