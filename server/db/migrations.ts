import type { Database } from './sqlite';

/**
 * A table rebuild (`CREATE … _v2`, copy, `DROP`, `RENAME`): its statements run in one transaction with the foreign
 * keys off. With them on, the `DROP TABLE` of a parent deletes its rows first, and `ON DELETE SET NULL` would empty
 * every link to it. `PRAGMA foreign_keys` has no effect inside a transaction, so the runner sets it around.
 */
export interface Rebuild {
  rebuild: string[];
}

export type Migration = string | Rebuild;

/** One entry per schema version; never change a migration that has shipped, add a new one. */
export const MIGRATIONS: Migration[] = [
  // 1 — key/value settings
  `CREATE TABLE settings(key TEXT PRIMARY KEY, value_json TEXT NOT NULL);`,
  // 2 — llama-server profiles
  `CREATE TABLE profiles(
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
  );`,
  // 3 — cached GGUF summaries (key: path; stamp: mtime and size of each part)
  `CREATE TABLE model_cache(path TEXT PRIMARY KEY, stamp TEXT NOT NULL, summary_json TEXT NOT NULL, read_at INTEGER NOT NULL);`,
  // 4 — chat conversations
  `CREATE TABLE conversations(
    id INTEGER PRIMARY KEY,
    title TEXT NOT NULL,
    profile_id INTEGER REFERENCES profiles(id) ON DELETE SET NULL,
    model_path TEXT,
    sampling_json TEXT NOT NULL,
    system_prompt TEXT NOT NULL,
    thinking INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );`,
  // 5 — messages (reasoning kept separate, generation status, stats taken from the timings)
  `CREATE TABLE messages(
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
  );`,
  // 6
  `CREATE INDEX messages_by_conversation ON messages(conversation_id, id);`,
  // 7 — benchmark runs (args_json = BenchSpec, frozen hardware, stats_json = { pp, tg, draftAcceptPct })
  `CREATE TABLE bench_runs(
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
  );`,
  // 8
  `CREATE INDEX bench_runs_by_date ON bench_runs(created_at DESC);`,
  // 9 — sweeps (spec_json = SweepSpec); best_run_id targets bench_runs by name, rebuilt right after
  `CREATE TABLE sweeps(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    status TEXT NOT NULL,
    model_path TEXT NOT NULL,
    profile_id INTEGER REFERENCES profiles(id) ON DELETE SET NULL,
    spec_json TEXT NOT NULL,
    best_run_id INTEGER REFERENCES bench_runs(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL,
    finished_at INTEGER
  );`,
  // 10–14 — bench_runs rebuilt with AUTOINCREMENT (a deleted id is never reused: sweeps.best_run_id relies on it),
  // with sweep membership (sweep_id, label, estimator verdict). The milestone 5 rows are copied over.
  `CREATE TABLE bench_runs_v2(
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
  );`,
  `INSERT INTO bench_runs_v2(id, kind, status, model_path, profile_id, args_json, command, hardware_json, pp_tps, tg_tps, stats_json, vram_mib_json, error, log_excerpt, duration_ms, sweep_id, created_at) SELECT id, kind, status, model_path, profile_id, args_json, command, hardware_json, pp_tps, tg_tps, stats_json, vram_mib_json, error, log_excerpt, duration_ms, sweep_id, created_at FROM bench_runs;`,
  `DROP TABLE bench_runs;`,
  `ALTER TABLE bench_runs_v2 RENAME TO bench_runs;`,
  `CREATE INDEX bench_runs_by_date ON bench_runs(created_at DESC);`,
  // 15
  `CREATE INDEX bench_runs_by_sweep ON bench_runs(sweep_id, id);`,
  // 16 — Hugging Face download queue (files_json = DownloadFile[]; dir = absolute destination folder)
  `CREATE TABLE downloads(
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
  );`,
  // 17 — profiles rebuilt with AUTOINCREMENT, ids kept: a deleted profile's id is never given to a new one, so a run,
  // a sweep, a conversation or the last started profile never points to another profile.
  {
    rebuild: [
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
    ],
  },
];

type Violation = { table: string; rowid: number; parent: string; fkid: number };
const violations = (db: Database) =>
  new Set(
    db
      .query<Violation, []>('PRAGMA foreign_key_check')
      .all()
      .map((v) => `${v.table}:${v.rowid}:${v.fkid}`),
  );

function runRebuild(db: Database, m: Rebuild, version: number): void {
  const fk = db.query<{ foreign_keys: number }, []>('PRAGMA foreign_keys').get()?.foreign_keys ?? 0;
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    db.transaction(() => {
      // A violation already there (an old database) is not the rebuild's: only new ones abort it.
      const before = violations(db);
      for (const sql of m.rebuild) db.exec(sql);
      const broken = [...violations(db)].filter((v) => !before.has(v));
      if (broken.length > 0) throw new Error(`migration ${version}: broken foreign keys (${broken.join(', ')})`);
      db.run('UPDATE schema_version SET version = ?', [version]);
    })();
  } finally {
    if (fk) db.exec('PRAGMA foreign_keys = ON');
  }
}

/** Brings the schema to `upTo` (the last version by default; tests stop earlier to fill an old schema). */
export function runMigrations(db: Database, upTo: number = MIGRATIONS.length): void {
  db.exec('CREATE TABLE IF NOT EXISTS schema_version(version INTEGER NOT NULL)');
  const row = db.query<{ version: number }, []>('SELECT version FROM schema_version LIMIT 1').get();
  let current = row?.version ?? 0;
  if (!row) db.run('INSERT INTO schema_version(version) VALUES (0)');
  while (current < upTo) {
    const m = MIGRATIONS[current]!;
    const next = current + 1;
    if (typeof m === 'string')
      db.transaction(() => {
        db.exec(m);
        db.run('UPDATE schema_version SET version = ?', [next]);
      })();
    else runRebuild(db, m, next);
    current = next;
  }
}
