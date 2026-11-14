import { Array as Arr, Effect, Schema } from 'effect';
import { SqlClient, type SqlError } from 'effect/sql';

/** A table rebuild left a link pointing to no row: the migration is rolled back. */
export class BrokenForeignKeys extends Schema.TaggedError<
  BrokenForeignKeys,
  { readonly BrokenForeignKeys: unique symbol }
>()('BrokenForeignKeys', { message: Schema.String }) {}

/** A migration: its statements, run one at a time in the migrator's transaction. */
type Migration = Effect.Effect<void, SqlError.SqlError | BrokenForeignKeys, SqlClient.SqlClient>;

const statements = (...sqls: ReadonlyArray<string>): Migration =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    for (const text of sqls) yield* sql.unsafe(text);
  });

/** The links that point to no row, as `<table>:<rowid>:<foreign key>`. */
const violations = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{
    readonly table: string;
    readonly rowid: number;
    readonly fkid: number;
  }>`PRAGMA foreign_key_check`;
  return Arr.map(rows, (v) => `${v.table}:${v.rowid}:${v.fkid}`);
});

/**
 * A table rebuild (`CREATE … _v2`, copy, `DROP`, `RENAME`). It runs with the foreign keys off (`Db` sets them
 * around the migrator: `PRAGMA foreign_keys` does nothing inside a transaction): with them on, the `DROP TABLE` of a
 * parent deletes its rows first, and `ON DELETE SET NULL` would empty every link to it. A violation already there (an
 * old database) is not the rebuild's: only new ones abort it.
 */
const rebuild = (version: number, sqls: ReadonlyArray<string>): Migration =>
  Effect.gen(function* () {
    const before = yield* violations;
    yield* statements(...sqls);
    const after = yield* violations;
    const broken = Arr.difference(after, before);
    if (Arr.isArrayNonEmpty(broken)) {
      return yield* BrokenForeignKeys.make({
        message: `migration ${version}: broken foreign keys (${Arr.join(broken, ', ')})`,
      });
    }
  });

/**
 * The 17 migrations of the Nitro server, one for one, keyed `0001_<name>` … `0017_<name>` for `Migrator.fromRecord`,
 * the SQL text unchanged (`sqlite_schema` keeps it as written). Never change a migration that has shipped, add one.
 */
export const MIGRATIONS: Record<string, Migration> = {
  // key/value settings
  '0001_settings': statements(`CREATE TABLE settings(key TEXT PRIMARY KEY, value_json TEXT NOT NULL);`),
  // llama-server profiles
  '0002_profiles': statements(`CREATE TABLE profiles(
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    model_path TEXT NOT NULL,
    mmproj_path TEXT,
    cwd TEXT,
    host TEXT,
    port INTEGER,
    args_json TEXT NOT NULL,
    env_json TEXT NOT NULL,
    source TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );`),
  // cached GGUF summaries (key: path; stamp: mtime and size of each part)
  '0003_model_cache': statements(
    `CREATE TABLE model_cache(path TEXT PRIMARY KEY, stamp TEXT NOT NULL, summary_json TEXT NOT NULL, read_at INTEGER NOT NULL);`,
  ),
  // chat conversations
  '0004_conversations': statements(`CREATE TABLE conversations(
    id INTEGER PRIMARY KEY,
    title TEXT NOT NULL,
    profile_id INTEGER REFERENCES profiles(id) ON DELETE SET NULL,
    model_path TEXT,
    sampling_json TEXT NOT NULL,
    system_prompt TEXT NOT NULL,
    thinking INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );`),
  // messages (reasoning kept separate, generation status, stats taken from the timings)
  '0005_messages': statements(`CREATE TABLE messages(
    id INTEGER PRIMARY KEY,
    conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    reasoning TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL,
    error TEXT,
    stats_json TEXT,
    model_path TEXT,
    created_at INTEGER NOT NULL
  );`),
  '0006_messages_by_conversation': statements(
    `CREATE INDEX messages_by_conversation ON messages(conversation_id, id);`,
  ),
  // benchmark runs (args_json = BenchSpec, frozen hardware, stats_json = { pp, tg, draftAcceptPct })
  '0007_bench_runs': statements(`CREATE TABLE bench_runs(
    id INTEGER PRIMARY KEY,
    kind TEXT NOT NULL,
    status TEXT NOT NULL,
    model_path TEXT NOT NULL,
    profile_id INTEGER REFERENCES profiles(id) ON DELETE SET NULL,
    args_json TEXT NOT NULL,
    command TEXT NOT NULL,
    hardware_json TEXT NOT NULL,
    pp_tps REAL,
    tg_tps REAL,
    stats_json TEXT,
    vram_mib_json TEXT NOT NULL,
    error TEXT,
    log_excerpt TEXT NOT NULL DEFAULT '',
    duration_ms INTEGER,
    sweep_id INTEGER,
    created_at INTEGER NOT NULL
  );`),
  '0008_bench_runs_by_date': statements(`CREATE INDEX bench_runs_by_date ON bench_runs(created_at DESC);`),
  // sweeps (spec_json = SweepSpec); best_run_id targets bench_runs by name, rebuilt right after
  '0009_sweeps': statements(`CREATE TABLE sweeps(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    status TEXT NOT NULL,
    model_path TEXT NOT NULL,
    profile_id INTEGER REFERENCES profiles(id) ON DELETE SET NULL,
    spec_json TEXT NOT NULL,
    best_run_id INTEGER REFERENCES bench_runs(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL,
    finished_at INTEGER
  );`),
  // 10–14: bench_runs rebuilt with AUTOINCREMENT (a deleted id is never reused: sweeps.best_run_id relies on it), with sweep membership (sweep_id, label, estimator verdict). The milestone 5 rows are copied over.
  '0010_bench_runs_v2': statements(`CREATE TABLE bench_runs_v2(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    status TEXT NOT NULL,
    model_path TEXT NOT NULL,
    profile_id INTEGER REFERENCES profiles(id) ON DELETE SET NULL,
    args_json TEXT NOT NULL,
    command TEXT NOT NULL,
    hardware_json TEXT NOT NULL,
    pp_tps REAL,
    tg_tps REAL,
    stats_json TEXT,
    vram_mib_json TEXT NOT NULL,
    error TEXT,
    log_excerpt TEXT NOT NULL DEFAULT '',
    duration_ms INTEGER,
    sweep_id INTEGER REFERENCES sweeps(id) ON DELETE CASCADE,
    sweep_label TEXT,
    fit TEXT,
    created_at INTEGER NOT NULL
  );`),
  '0011_bench_runs_v2_copy': statements(
    `INSERT INTO bench_runs_v2(id, kind, status, model_path, profile_id, args_json, command, hardware_json, pp_tps, tg_tps, stats_json, vram_mib_json, error, log_excerpt, duration_ms, sweep_id, created_at) SELECT id, kind, status, model_path, profile_id, args_json, command, hardware_json, pp_tps, tg_tps, stats_json, vram_mib_json, error, log_excerpt, duration_ms, sweep_id, created_at FROM bench_runs;`,
  ),
  '0012_bench_runs_drop': statements(`DROP TABLE bench_runs;`),
  '0013_bench_runs_v2_rename': statements(`ALTER TABLE bench_runs_v2 RENAME TO bench_runs;`),
  '0014_bench_runs_v2_by_date': statements(`CREATE INDEX bench_runs_by_date ON bench_runs(created_at DESC);`),
  '0015_bench_runs_by_sweep': statements(`CREATE INDEX bench_runs_by_sweep ON bench_runs(sweep_id, id);`),
  // Hugging Face download queue (files_json = DownloadFile[]; dir = absolute destination folder)
  '0016_downloads': statements(`CREATE TABLE downloads(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    repo TEXT NOT NULL,
    revision TEXT NOT NULL,
    variant_key TEXT NOT NULL,
    name TEXT NOT NULL,
    quant TEXT,
    kind TEXT NOT NULL,
    dir TEXT NOT NULL,
    files_json TEXT NOT NULL,
    status TEXT NOT NULL,
    bytes_done INTEGER NOT NULL DEFAULT 0,
    total_bytes INTEGER NOT NULL,
    error TEXT,
    code TEXT,
    created_at INTEGER NOT NULL,
    finished_at INTEGER
  );`),
  // profiles rebuilt with AUTOINCREMENT, ids kept: a deleted profile's id is never given to a new one, so a run, a
  // sweep, a conversation or the last started profile never points to another profile.
  '0017_profiles_autoincrement': rebuild(17, [
    `CREATE TABLE profiles_v2(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        model_path TEXT NOT NULL,
        mmproj_path TEXT,
        cwd TEXT,
        host TEXT,
        port INTEGER,
        args_json TEXT NOT NULL,
        env_json TEXT NOT NULL,
        source TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );`,
    `INSERT INTO profiles_v2(id, name, model_path, mmproj_path, cwd, host, port, args_json, env_json, source, created_at, updated_at) SELECT id, name, model_path, mmproj_path, cwd, host, port, args_json, env_json, source, created_at, updated_at FROM profiles;`,
    `DROP TABLE profiles;`,
    `ALTER TABLE profiles_v2 RENAME TO profiles;`,
  ]),
};
