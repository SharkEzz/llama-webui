// SQLite on node:sqlite, with the bun:sqlite surface the repositories use: `query()` caches its statement, `get()`
// returns null for no row, `run(sql)` takes several statements, `transaction(fn)` returns a function. The class is
// `DatabaseSync`: Bun's node:sqlite has no `Database` export (Node 26 keeps `DatabaseSync` as its alias).
import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite';

export type Binding = string | number | bigint | boolean | null | undefined | Uint8Array;

export interface Changes {
  changes: number;
  lastInsertRowid: number | bigint;
}

export interface Query<Row, P extends Binding[]> {
  get(...params: P): Row | null;
  all(...params: P): Row[];
  run(...params: P): Changes;
}

export interface DatabaseOptions {
  readonly?: boolean;
  /** Accepted for bun:sqlite parity: a missing file is always created (unless `readonly`). */
  create?: boolean;
}

/** bun:sqlite binds booleans as 1/0 and `undefined` as NULL; Bun's node:sqlite refuses both. */
const bind = (params: Binding[]): SQLInputValue[] =>
  params.map((p) => (p === undefined ? null : typeof p === 'boolean' ? Number(p) : p));

const wrap = <Row, P extends Binding[]>(s: StatementSync): Query<Row, P> => ({
  get: (...p) => (s.get(...bind(p)) as Row | undefined) ?? null,
  all: (...p) => s.all(...bind(p)) as Row[],
  run: (...p) => s.run(...bind(p)) as Changes,
});

export class Database implements Disposable {
  #raw: DatabaseSync;
  #cache = new Map<string, StatementSync>();

  constructor(path: string, o: DatabaseOptions = {}) {
    // Foreign keys off unless turned on, as in bun:sqlite (`openDb()` turns them on).
    this.#raw = new DatabaseSync(path, { readOnly: o.readonly ?? false, enableForeignKeyConstraints: false });
  }

  #stmt(sql: string): StatementSync {
    let s = this.#cache.get(sql);
    if (!s) {
      s = this.#raw.prepare(sql);
      this.#cache.set(sql, s);
    }
    return s;
  }

  /** A statement cached by its SQL text, as bun:sqlite's `query()`. Only the first statement of `sql` runs. */
  query<Row = unknown, P extends Binding[] = Binding[]>(sql: string): Query<Row, P> {
    return wrap<Row, P>(this.#stmt(sql));
  }

  /** Like `query()`, without the cache. */
  prepare<Row = unknown, P extends Binding[] = Binding[]>(sql: string): Query<Row, P> {
    return wrap<Row, P>(this.#raw.prepare(sql));
  }

  /** Runs `sql`; without parameters it may hold several statements (`prepare()` would drop all but the first). */
  run(sql: string, params: Binding[] = []): Changes {
    if (params.length > 0) return this.#stmt(sql).run(...bind(params)) as Changes;
    this.#raw.exec(sql);
    return this.#stmt(
      'SELECT changes() AS changes, last_insert_rowid() AS lastInsertRowid',
    ).get() as unknown as Changes;
  }

  /**
   * Wraps `fn` in a transaction, as bun:sqlite (better-sqlite3's algorithm): a savepoint when one is already open, and
   * a rollback only while SQLite has not already rolled back itself, so the error thrown is always `fn`'s.
   */
  transaction<A extends unknown[], R>(fn: (...a: A) => R): (...a: A) => R {
    return (...a) => {
      const nested = this.#raw.isTransaction;
      this.#raw.exec(nested ? 'SAVEPOINT lw_tx' : 'BEGIN');
      try {
        const r = fn(...a);
        this.#raw.exec(nested ? 'RELEASE lw_tx' : 'COMMIT');
        return r;
      } catch (e) {
        if (this.#raw.isTransaction) this.#raw.exec(nested ? 'ROLLBACK TO lw_tx; RELEASE lw_tx' : 'ROLLBACK');
        throw e;
      }
    };
  }

  /** Closes the handle; a second call does nothing, as in bun:sqlite. */
  close(): void {
    if (!this.#raw.isOpen) return;
    this.#cache.clear();
    this.#raw.close();
  }

  [Symbol.dispose](): void {
    this.close();
  }
}
