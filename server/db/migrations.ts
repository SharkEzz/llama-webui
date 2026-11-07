import type { Database } from 'bun:sqlite';

/** Une entrée par version de schéma ; ne jamais modifier une migration déjà livrée, en ajouter une nouvelle. */
export const MIGRATIONS: string[] = [
  // 1 — réglages clé/valeur
  `CREATE TABLE settings(key TEXT PRIMARY KEY, value_json TEXT NOT NULL);`,
  // 2 — profils llama-server
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
  // 3 — résumés GGUF en cache (clé : chemin ; stamp : mtime et taille de chaque partie)
  `CREATE TABLE model_cache(path TEXT PRIMARY KEY, stamp TEXT NOT NULL, summary_json TEXT NOT NULL, read_at INTEGER NOT NULL);`,
  // 4 — conversations du chat
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
  // 5 — messages (réflexion à part, statut de génération, stats tirées des timings)
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
  // 7 — runs de benchmark (args_json = BenchSpec, matériel figé, stats_json = { pp, tg, draftAcceptPct })
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
  // 9 — sweeps (spec_json = SweepSpec) ; best_run_id vise bench_runs par son nom, reconstruite juste après
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
  // 10–14 — bench_runs reconstruite en AUTOINCREMENT (un id supprimé n'est jamais redonné : sweeps.best_run_id s'y fie),
  // avec l'appartenance à un sweep (sweep_id, étiquette, verdict de l'estimateur). Les lignes de J5 sont recopiées.
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
];

export function runMigrations(db: Database): void {
  db.run('CREATE TABLE IF NOT EXISTS schema_version(version INTEGER NOT NULL)');
  const row = db.query<{ version: number }, []>('SELECT version FROM schema_version LIMIT 1').get();
  let current = row?.version ?? 0;
  if (!row) db.run('INSERT INTO schema_version(version) VALUES (0)');
  while (current < MIGRATIONS.length) {
    const sql = MIGRATIONS[current]!;
    const next = current + 1;
    db.transaction(() => {
      db.run(sql);
      db.run('UPDATE schema_version SET version = ?', [next]);
    })();
    current = next;
  }
}
