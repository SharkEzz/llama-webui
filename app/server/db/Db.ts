import { SqliteClient, SqliteMigrator } from '@effect/sql-sqlite-node';
import { Effect, FileSystem, Layer, Path } from 'effect';
import { SqlClient } from 'effect/sql';
import { AppConfig } from '../config/AppConfig.ts';
import { keepSchemaVersion, recognise } from './LegacyBridge.ts';
import { MIGRATIONS } from './migrations.ts';

/** The file of the database in the data directory, the Nitro server's. */
const FILENAME = 'llama-webui.sqlite';

/**
 * Brings the open database up to date. The foreign keys are off while the migrations run (the client leaves them on,
 * migration 17 rebuilds `profiles`, and the pragma does nothing inside the migrator's transaction), and on after.
 */
const open = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`PRAGMA foreign_keys = OFF`;
  yield* recognise;
  yield* SqliteMigrator.run({ loader: SqliteMigrator.fromRecord(MIGRATIONS) });
  yield* sql`PRAGMA foreign_keys = ON`;
  yield* keepSchemaVersion;
}).pipe(Effect.withSpan('Db.open'));

/** The database in `filename` (`:memory:` in tests), opened (WAL) and brought up to date. */
export const layerAt = (filename: string) =>
  Layer.effectDiscard(open).pipe(Layer.provideMerge(SqliteClient.layer({ filename })));

/** `<dataDir>/llama-webui.sqlite`, the data directory created if missing, opened and brought up to date. */
export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const { dataDir } = yield* AppConfig;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.makeDirectory(dataDir, { recursive: true });
    return layerAt(path.join(dataDir, FILENAME));
  }),
);
