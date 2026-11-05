import type { Database } from "bun:sqlite";

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
];

export function runMigrations(db: Database): void {
  db.run("CREATE TABLE IF NOT EXISTS schema_version(version INTEGER NOT NULL)");
  const row = db.query<{ version: number }, []>("SELECT version FROM schema_version LIMIT 1").get();
  let current = row?.version ?? 0;
  if (!row) db.run("INSERT INTO schema_version(version) VALUES (0)");
  while (current < MIGRATIONS.length) {
    const sql = MIGRATIONS[current]!;
    const next = current + 1;
    db.transaction(() => {
      db.run(sql);
      db.run("UPDATE schema_version SET version = ?", [next]);
    })();
    current = next;
  }
}
