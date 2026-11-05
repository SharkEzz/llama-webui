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
