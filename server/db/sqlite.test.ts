import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { tempDir } from '../testing/tempDir';
import { Database } from './sqlite';

const withTable = () => {
  const db = new Database(':memory:');
  db.run('CREATE TABLE t(id INTEGER PRIMARY KEY AUTOINCREMENT, a, b TEXT UNIQUE)');
  return db;
};
const rows = (db: Database) => db.query<{ a: unknown; b: string }, []>('SELECT a, b FROM t ORDER BY id').all();

test('get returns null when no row matches, all the rows, run the changes and the last rowid', () => {
  using db = withTable();
  expect(db.query('SELECT * FROM t WHERE id = ?').get(1)).toBeNull();
  expect(db.query<unknown, [number, string]>('INSERT INTO t(a, b) VALUES (?, ?)').run(1, 'x')).toEqual({
    changes: 1,
    lastInsertRowid: 1,
  });
  expect(db.run('INSERT INTO t(a, b) VALUES (?, ?)', [2, 'y'])).toEqual({ changes: 1, lastInsertRowid: 2 });
  expect(rows(db)).toEqual([
    { a: 1, b: 'x' },
    { a: 2, b: 'y' },
  ]);
  expect(db.prepare<{ b: string }, [number]>('SELECT b FROM t WHERE a = ?').get(2)).toEqual({ b: 'y' });
});

test('RETURNING rows are read through get', () => {
  using db = withTable();
  expect(db.query<{ id: number }, [string]>('INSERT INTO t(b) VALUES (?) RETURNING id').get('r')).toEqual({ id: 1 });
});

test('run without parameters executes every statement and returns the changes of the last write', () => {
  using db = withTable();
  db.run("CREATE TABLE u(x); INSERT INTO t(b) VALUES ('1'); INSERT INTO t(b) VALUES ('2')");
  expect(db.query('SELECT name FROM sqlite_master WHERE name = ?').get('u')).toEqual({ name: 'u' });
  expect(db.run("UPDATE t SET a = 0 WHERE b IN ('1', '2')").changes).toBe(2);
});

test('booleans bind as 1 and 0, undefined as NULL (Bun refuses them in node:sqlite)', () => {
  using db = withTable();
  db.query('INSERT INTO t(a, b) VALUES (?, ?)').run(true, 't');
  db.run('INSERT INTO t(a, b) VALUES (?, ?)', [false, 'f']);
  db.query('INSERT INTO t(a, b) VALUES (?, ?)').run(undefined, 'u');
  expect(rows(db)).toEqual([
    { a: 1, b: 't' },
    { a: 0, b: 'f' },
    { a: null, b: 'u' },
  ]);
});

test('a transaction returns its value and commits; a throw rolls back and rethrows the same error', () => {
  using db = withTable();
  expect(db.transaction((b: string) => db.run('INSERT INTO t(b) VALUES (?)', [b]).lastInsertRowid)('ok')).toBe(1);
  const boom = new Error('boom');
  expect(() =>
    db.transaction(() => {
      db.run("INSERT INTO t(b) VALUES ('gone')");
      throw boom;
    })(),
  ).toThrow(boom);
  expect(rows(db).map((r) => r.b)).toEqual(['ok']);
});

test('a nested transaction is a savepoint: a caught inner failure only undoes the inner writes', () => {
  using db = withTable();
  const inner = db.transaction(() => {
    db.run("INSERT INTO t(b) VALUES ('inner')");
    throw new Error('inner');
  });
  db.transaction(() => {
    db.run("INSERT INTO t(b) VALUES ('outer')");
    expect(inner).toThrow('inner');
    db.run("INSERT INTO t(b) VALUES ('after')");
  })();
  expect(rows(db).map((r) => r.b)).toEqual(['outer', 'after']);
});

test('an error that made SQLite roll back the transaction itself is rethrown as is', () => {
  using db = withTable();
  db.run("INSERT INTO t(b) VALUES ('dup')");
  expect(() => db.transaction(() => db.run("INSERT OR ROLLBACK INTO t(b) VALUES ('dup')"))()).toThrow(/UNIQUE/);
  db.transaction(() => db.run("INSERT INTO t(b) VALUES ('next')"))(); // no transaction left open
  expect(rows(db).map((r) => r.b)).toEqual(['dup', 'next']);
});

test('foreign keys are off by default, readonly refuses writes, close is idempotent, using closes', () => {
  using dir = tempDir('lw-sqlite-');
  const path = join(dir.path, 'f.sqlite');
  const db = new Database(path, { create: true });
  expect(db.query<{ foreign_keys: number }, []>('PRAGMA foreign_keys').get()!.foreign_keys).toBe(0);
  db.run('CREATE TABLE t(a)');
  db.close();
  expect(() => db.close()).not.toThrow();
  const ro = new Database(path, { readonly: true });
  expect(() => ro.run('INSERT INTO t VALUES (?)', [1])).toThrow(/readonly/);
  {
    using scoped = ro;
    expect(scoped.query('SELECT count(*) n FROM t').get()).toEqual({ n: 0 });
  }
  expect(() => ro.query('SELECT 1').get()).toThrow();
});
