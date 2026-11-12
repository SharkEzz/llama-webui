# N3 — `bun:sqlite` → `node:sqlite`: task plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** the server opens and queries SQLite through `node:sqlite`, behind `server/db/sqlite.ts`, a wrapper with the
`bun:sqlite` surface the repositories use; no file imports `bun:sqlite` any more. Bun still runs everything.

**Architecture:** one class, `Database`, wraps `DatabaseSync` and reproduces `bun:sqlite`'s behaviour where the two
differ (statement cache, `null` for no row, bindings, transactions, default pragmas, idempotent `close`). The 12
importers change their import line only.

**Tech Stack:** Bun 1.4.4 (runtime, its built-in `node:sqlite`), Node 26.13.0, TypeScript 7.0.2.

**Spec:** [`2026-11-12-node-migration.md`](./2026-11-12-node-migration.md), section N3.

## Global Constraints

- Behaviour-identical port: same schema, same rows, same HTTP contract; no refactoring (candidates → notes).
- Probed on this machine (planning): Bun's `node:sqlite` exports `DatabaseSync` only (no `Database`), and
  `@types/node` 26.6 declares only `DatabaseSync`; it **rejects** `true`/`false`/`undefined` bindings
  (`ERR_INVALID_ARG_TYPE`), which `bun:sqlite` binds as `1`/`0`/`NULL` and Node ≥ 26.10 accepts. Rows are
  null-prototype on both (`bun:test` `toEqual` and `toStrictEqual` accept them). `readOnly` is camelCase (an unknown
  `readonly` key is silently ignored). `enableForeignKeyConstraints` defaults to `true` (`bun:sqlite`: off).
  `bun:sqlite` closes twice without error; `DatabaseSync` throws on the second `close()`.
- `bun:sqlite` throws when the number of bound values does not match the placeholders; `node:sqlite` binds missing ones
  as `NULL` and exposes no parameter count. (Revised during execution, after a review note) The wrapper counts the `?`
  outside strings, quoted names and comments and throws `bun:sqlite`'s message.
- Biome clean, `bun run check` clean, gate below green at every commit.

## Review Focus

- A transaction whose body throws after SQLite already rolled back (for example a constraint error inside a
  statement that aborts the transaction): `ROLLBACK` must not mask the original error (roll back only while
  `isTransaction`).
- A nested `transaction()` (a repository method calling another inside its own transaction): savepoint, inner failure
  undoes only the inner work when the outer catches it.
- `db.run(sql)` without parameters on a multi-statement string (`prepare()` would silently drop the rest, fact 2).
- The migrations' foreign-key toggle around a rebuild (`runRebuild`) with the new default pragmas; `defensive: true`
  must not block a rebuild (`migrations.test.ts` decides).
- The standalone binary: `bun build --compile` must embed `node:sqlite` (smoke-binary opens the database).

---

### Task 1: `server/db/sqlite.ts`

**Files:** Create `server/db/sqlite.ts`, `server/db/sqlite.test.ts`.

**Interfaces — Produces:**

```ts
export type Binding = string | number | bigint | boolean | null | undefined | Uint8Array;
export interface Changes {
  changes: number;
  lastInsertRowid: number | bigint;
}
export interface Query<Row, P extends Binding[]> {
  get(...p: P): Row | null;
  all(...p: P): Row[];
  run(...p: P): Changes;
}
export interface DatabaseOptions {
  readonly?: boolean;
  create?: boolean;
} // create: accepted, a missing file is always created
export class Database implements Disposable {
  constructor(path: string, o?: DatabaseOptions); // foreign keys off by default, as bun:sqlite
  query<Row = unknown, P extends Binding[] = Binding[]>(sql: string): Query<Row, P>; // statement cached by SQL text
  prepare<Row = unknown, P extends Binding[] = Binding[]>(sql: string): Query<Row, P>; // not cached
  run(sql: string, params?: Binding[]): Changes; // no params: exec (several statements), then changes()
  transaction<A extends unknown[], R>(fn: (...a: A) => R): (...a: A) => R;
  close(): void; // idempotent
}
```

Bindings: `undefined` → `null`, `boolean` → `1`/`0`. Transactions follow `bun:sqlite` (better-sqlite3's algorithm):
`SAVEPOINT` when `isTransaction` is already true, else `BEGIN`; on error, `ROLLBACK [TO …]` (+ `RELEASE` for a
savepoint) only while `isTransaction`, then rethrow.

- [ ] **Step 1: Write the failing tests** in `server/db/sqlite.test.ts` (`bun:test`, `:memory:` unless stated):
  - `get` returns `null` when no row matches, `all` the rows, `run` `{ changes, lastInsertRowid }`;
  - `RETURNING` rows are read through `get`;
  - `run` without parameters executes every statement of the string and returns the last DML's `changes`;
  - `true`/`false`/`undefined` bind as `1`/`0`/`NULL` (both through `query()` and `run(sql, params)`);
  - `transaction` returns its function's value and commits; a throw rolls back and rethrows the same error;
  - nested: the outer catches the inner's throw → only the inner rows are gone;
  - an error after SQLite aborted the transaction itself (`INSERT OR ROLLBACK` on a constraint) rethrows that error,
    not `cannot rollback - no transaction is active`;
  - foreign keys are off by default; `readonly: true` refuses a write (`tempDir` file); `close()` twice does not throw;
    `using` closes the handle (a later `query` throws).
- [ ] **Step 2: Run** `bun test server/db/sqlite.test.ts`. Expected: FAIL, `Cannot find module './sqlite'`.
- [ ] **Step 3: Implement** `server/db/sqlite.ts`.
- [ ] **Step 4: Run** `bun test server/db/sqlite.test.ts` (Bun only until N4: the server's extensionless imports do
      not run under plain Node). Expected: PASS.
- [ ] **Step 5: Commit** `feat(db): Wrap node:sqlite with the bun:sqlite surface the repositories use`.

### Task 2: Switch the importers

**Files:** Modify the import line of `server/db/{open,migrations,profiles,settings,conversations,benchRuns,sweeps,
downloads,modelCache}.ts`, `server/app.ts`, `server/routes/{models,setup}.ts`, `server/db/{migrations,sweeps}.test.ts`
(`from 'bun:sqlite'` → `from './sqlite'` / `'../db/sqlite'` / `'./db/sqlite'`).

**Interfaces — Consumes:** Task 1's `Database`. `open.ts` keeps `{ create: true }`, `PRAGMA journal_mode = WAL` and
`PRAGMA foreign_keys = ON`; `sweeps.test.ts` keeps `{ readonly: true }`.

- [ ] **Step 1: Switch** the imports; `grep -rn "bun:sqlite" server packages scripts testdata` (excluding
      `server/.tsbuild`). Expected: no match.
- [ ] **Step 2: Run** `bun run check`, then `bun test server/db server/routes`. Expected: clean, PASS. If
      `migrations.test.ts` fails on `defensive`, pass `defensive: false` in the wrapper and ledger it.
- [ ] **Step 3: Run** the gate: `bun run lint`, `bun test`, `bun run compile` + `bun scripts/smoke-binary.ts`.
      Expected: green; the smoke opens a fresh database through the compiled binary.
- [ ] **Step 4: Commit** `refactor(db): Open SQLite through node:sqlite`.

### Task 3: Docs

**Files:** `site/content/developers/server/database.mdx` (opening, the wrapper and its differences from raw
`node:sqlite`, the `bun --hot` sentence stays true until N8), `developers/index.mdx` (runtime and database rows, link
text), `developers/getting-started.mdx` (tree), `developers/architecture.mdx` (startup step),
`developers/contributing/conventions.mdx` (SQLite row), `site/src/docs/ArchitectureDiagram.tsx`, `README.md`
(architecture table), `CLAUDE.md` (APIs line and the "Dans ce projet" paragraph; mapping row for
`server/db/sqlite.ts` is covered by `server/db/**`), notes file (Bun's `node:sqlite` gaps, `DatabaseSync` → `Database`
at N8, the parameter-count divergence).

- [ ] **Step 1: Edit** the pages; `grep -rn "bun:sqlite"` over `site/content site/src README.md CLAUDE.md`. Expected:
      no match outside historical plans.
- [ ] **Step 2: Run** `bun run site:build` and `bun run --cwd site check-links`. Expected: OK, 0 broken.
- [ ] **Step 3: Commit** `docs: Describe the node:sqlite wrapper`.

## Gate (N1–N3)

`bun run lint`, `bun run check`, `bun test`, `bun run --cwd packages/llamacpp-js test:node`, `bun run compile` +
`bun scripts/smoke-binary.ts`, `bun run site:build` + `bun run --cwd site check-links`.
