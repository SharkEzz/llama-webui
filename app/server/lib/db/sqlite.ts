// SQLite on node:sqlite, with the surface the repositories use: `query()` caches its statement, `get()` returns null
// for no row, `exec(sql)` takes several statements, `transaction(fn)` returns a function, and values are bound
// strictly (see `bindOne`, `placeholders`). The class is `DatabaseSync` (Node 26 also exports it as `Database`).
import { DatabaseSync, type SQLInputValue, type StatementResultingChanges, type StatementSync } from 'node:sqlite';

export type Binding = string | number | bigint | boolean | null | undefined | Uint8Array;

export type Changes = {
  [P in keyof StatementResultingChanges]: Exclude<StatementResultingChanges[P], bigint>;
};

export interface Query<Row, P extends Binding[]> {
  get(...params: P): Row | null;
  all(...params: P): Row[];
  run(...params: P): Changes;
}

export interface DatabaseOptions {
  /** A missing file is created unless this is set. */
  readonly?: boolean;
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
 * Throws when `sql` holds a second statement: node:sqlite would prepare the first and drop the rest in silence.
 */
function placeholders(sql: string): number {
  /** Index of the last character of `token` after `from`, or the end of `sql` when it is not closed. */
  const end = (token: string, from: number) => {
    const at = sql.indexOf(token, from);
    return at === -1 ? sql.length : at + token.length - 1;
  };
  let n = 0;
  let ended = false;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    if (c === undefined) throw new RangeError('Could not find string at index in SQL string');
    if (c === '-' && sql[i + 1] === '-') i = end('\n', i + 2);
    else if (c === '/' && sql[i + 1] === '*') i = end('*/', i + 2);
    else if (ended && c.trim() !== '') throw new RangeError('SQLite query holds several statements: use exec()');
    // A doubled quote ('it''s') closes and reopens the string: the characters skipped are the same.
    else if (c === "'" || c === '"' || c === '`') i = end(c, i + 1);
    else if (c === '[') i = end(']', i + 1);
    else if (c === '?') n++;
    else if (c === ';') ended = true;
  }
  return n;
}

const wrap = <Row = unknown>(s: StatementSync, n: number): Query<Row, Binding[]> => {
  const check = (p: Binding[]): SQLInputValue[] => {
    if (p.length !== n) throw new RangeError(`SQLite query expected ${n} values, received ${p.length}`);
    return bind(p);
  };
  return {
    get: (...p) => (s.get(...check(p)) ?? null) as Row | null,
    all: (...p) => s.all(...check(p)) as Row[],
    run: (...p) => s.run(...check(p)) as Changes,
  };
};

export class Database implements Disposable {
  #raw: DatabaseSync;
  #cache = new Map<string, Query<unknown, Binding[]>>();

  constructor(path: string, o: DatabaseOptions = {}) {
    // Foreign keys off unless turned on, SQLite's default (`openDb()` turns them on).
    this.#raw = new DatabaseSync(path, { readOnly: o.readonly ?? false, enableForeignKeyConstraints: false });
  }

  /** A statement cached by its SQL text. `sql` holds one statement: several throw (`exec()` runs them). */
  query<Row = unknown, P extends Binding[] = Binding[]>(sql: string): Query<Row, P> {
    let q = this.#cache.get(sql) as Query<Row, P> | undefined;
    if (!q) {
      q = wrap<Row>(this.#raw.prepare(sql), placeholders(sql));
      this.#cache.set(sql, q);
    }
    return q;
  }

  /** Runs one statement (`query(sql).run(...params)`); several throw. */
  run(sql: string, params: Binding[] = []): Changes {
    return this.query(sql).run(...params);
  }

  /** Runs every statement of `sql`, without parameters nor result: schema, pragmas. */
  exec(sql: string): void {
    this.#raw.exec(sql);
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
