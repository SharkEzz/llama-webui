import { expect, test } from 'vitest';
import { MIGRATIONS, runMigrations } from './migrations';
import { openDb } from './open';
import { ProfilesRepo } from './profiles';
import { Database } from './sqlite';

const profile = (name: string) => ({ name, model: `/m/${name}.gguf`, args: [], env: {} });

test("a deleted profile's id is never given to a new profile (#38)", () => {
  const repo = new ProfilesRepo(openDb(':memory:'));
  repo.create(profile('a'));
  const b = repo.create(profile('b'));
  repo.remove(b.id);
  expect(repo.create(profile('c')).id).toBeGreaterThan(b.id);
});

test('rebuilding profiles keeps their ids and every link to them (#38)', () => {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db, 16);
  const now = 1;
  db.run(
    `INSERT INTO profiles(id, name, model_path, args_json, env_json, source, created_at, updated_at)
     VALUES (3, 'a', '/m/a.gguf', '[]', '{}', 'ui', ?, ?), (7, 'b', '/m/b.gguf', '["-c","4096"]', '{}', 'ui', ?, ?)`,
    [now, now, now, now],
  );
  db.run(
    `INSERT INTO conversations(title, profile_id, model_path, sampling_json, system_prompt, created_at, updated_at)
     VALUES ('t', 7, '/m/b.gguf', '{}', '', 1, 1)`,
  );
  db.run(
    `INSERT INTO sweeps(name, status, model_path, profile_id, spec_json, created_at) VALUES ('s', 'done', '/m/a.gguf', 3, '{}', 1)`,
  );
  db.run(
    `INSERT INTO bench_runs(kind, status, model_path, profile_id, args_json, command, hardware_json, vram_mib_json, created_at)
     VALUES ('bench', 'ok', '/m/b.gguf', 7, '{}', 'cmd', '{}', '[]', 1)`,
  );

  runMigrations(db);

  expect(db.query<{ version: number }, []>('SELECT version FROM schema_version').get()!.version).toBe(
    MIGRATIONS.length,
  );
  expect(db.query<{ id: number; name: string }, []>('SELECT id, name FROM profiles ORDER BY id').all()).toEqual([
    { id: 3, name: 'a' },
    { id: 7, name: 'b' },
  ]);
  expect(db.query<{ p: number }, []>('SELECT profile_id p FROM conversations').get()!.p).toBe(7);
  expect(db.query<{ p: number }, []>('SELECT profile_id p FROM sweeps').get()!.p).toBe(3);
  expect(db.query<{ p: number }, []>('SELECT profile_id p FROM bench_runs').get()!.p).toBe(7);
  expect(db.query<{ foreign_keys: number }, []>('PRAGMA foreign_keys').get()!.foreign_keys).toBe(1);
  expect(db.query('PRAGMA foreign_key_check').all()).toEqual([]);

  // The links still follow the profile: deleting it empties them, and its id is not reused.
  const repo = new ProfilesRepo(db);
  repo.remove(7);
  expect(db.query<{ p: number | null }, []>('SELECT profile_id p FROM conversations').get()!.p).toBeNull();
  expect(repo.create(profile('c')).id).toBe(8);
});
