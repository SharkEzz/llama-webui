import { DatabaseSync } from 'node:sqlite';
import { defineHandler } from 'nitro';

export default defineHandler(() => {
  const db = new DatabaseSync(':memory:');
  const row = db.prepare('select sqlite_version() as v').get();
  db.close();
  return { row };
});
