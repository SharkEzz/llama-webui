import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { runMigrations } from './migrations';
import { Database } from './sqlite';

export function openDb(path: string): Database {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true });
  db.run('PRAGMA journal_mode = WAL');
  db.run('PRAGMA foreign_keys = ON');
  runMigrations(db);
  return db;
}
