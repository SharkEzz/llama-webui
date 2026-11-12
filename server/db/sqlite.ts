// SQLite on node:sqlite, with the surface the repositories were written against: `query()` caches its statement,
// `get()` returns null for no row, `run(sql)` takes several statements, `transaction(fn)` returns a function, and
// values are bound strictly (see `bindOne`, `placeholders`). The class is `DatabaseSync` (Node 26 also exports it as
// `Database`).
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
  /** Accepted and ignored: a missing file is always created (unless `readonly`). */
  create?: boolean;
}

/**
 * What the repositories rely on: booleans bind as 1/0 and `undefined` as NULL, and an integral number as INTEGER
 * (node:sqlite binds every number as REAL: `'3.0'` in a TEXT column, `? / 2` dividing as floats).
 */
const bindOne = (p: Binding): SQLInputValue => {
  if (p === undefined) return null;
  if (typeof p === 'boolean') return BigInt(p);
  if (typeof p === 'number' && Number.isSafeInteger(p)) return BigInt(p);
  return p;
};
const bind = (params: Binding[]): SQLInputValue[] => params.map(bindOne);

/**
 * The number of `?` placeholders in `sql`, skipping quoted strings and names and comments. A statement run with
 * another number of values throws; node:sqlite would bind the missing ones as NULL, and exposes no count.
 */
export function placeholders(sql: string): number {
  /** Index of the last character of `token` after `from`, or the end of `sql` when it is not closed. */
  const end = (token: string, from: number) => {
    const at = sql.indexOf(token, from);
    return at === -1 ? sql.length : at + token.length - 1;
  };
  let n = 0;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    // A doubled quote ('it''s') closes and reopens the string: the characters skipped are the same.
    if (c === "'" || c === '"' || c === '`') i = end(c, i + 1);
    else if (c === '[') i = end(']', i + 1);
    else if (c === '-' && sql[i + 1] === '-') i = end('\n', i + 2);
    else if (c === '/' && sql[i + 1] === '*') i = end('*/', i + 2);
    else if (c === '?') n++;
  }
  return n;
}

interface Prepared {
  s: StatementSync;
  n: number;
}

const check = (n: number, p: Binding[]): SQLInputValue[] => {
  if (p.length !== n) throw new RangeError(`SQLite query expected ${n} values, received ${p.length}`);
  return bind(p);
};

const wrap = <Row, P extends Binding[]>({ s, n }: Prepared): Query<Row, P> => ({
  get: (...p) => (s.get(...check(n, p)) as Row | undefined) ?? null,
  all: (...p) => s.all(...check(n, p)) as Row[],
  run: (...p) => s.run(...check(n, p)) as Changes,
});

export class Database implements Disposable {
  #raw: DatabaseSync;
  #cache = new Map<string, Prepared>();

  constructor(path: string, o: DatabaseOptions = {}) {
    // Foreign keys off unless turned on, SQLite's default (`openDb()` turns them on).
    this.#raw = new DatabaseSync(path, { readOnly: o.readonly ?? false, enableForeignKeyConstraints: false });
  }

  #prepare(sql: string): Prepared {
    return { s: this.#raw.prepare(sql), n: placeholders(sql) };
  }

  #stmt(sql: string): Prepared {
    let p = this.#cache.get(sql);
    if (!p) {
      p = this.#prepare(sql);
      this.#cache.set(sql, p);
    }
    return p;
  }

  /** A statement cached by its SQL text. Only the first statement of `sql` runs. */
  query<Row = unknown, P extends Binding[] = Binding[]>(sql: string): Query<Row, P> {
    return wrap<Row, P>(this.#stmt(sql));
  }

  /** Like `query()`, without the cache. */
  prepare<Row = unknown, P extends Binding[] = Binding[]>(sql: string): Query<Row, P> {
    return wrap<Row, P>(this.#prepare(sql));
  }

  /** Runs `sql`; without parameters it may hold several statements (`prepare()` would drop all but the first). */
  run(sql: string, params: Binding[] = []): Changes {
    if (params.length > 0) return wrap(this.#stmt(sql)).run(...params);
    this.#raw.exec(sql);
    return wrap<Changes, []>(this.#stmt('SELECT changes() AS changes, last_insert_rowid() AS lastInsertRowid')).get()!;
  }

  /**
   * Wraps `fn` in a transaction (better-sqlite3's algorithm): a savepoint when one is already open, and
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

  /** Closes the handle; a second call does nothing. */
  close(): void {
    if (!this.#raw.isOpen) return;
    this.#cache.clear();
    this.#raw.close();
  }

  [Symbol.dispose](): void {
    this.close();
  }
}
