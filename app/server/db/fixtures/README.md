# Databases of the Nitro server

Two SQLite files written by the Nitro server's own code (`openDb`, `runMigrations` and the repositories of
`app/server/lib/db/`) on the tree of commit `b49a7c4c5`, through a temporary test deleted in the commit that added
them. The Effect server's tests open copies of them: a data directory of the Nitro server must open with its rows
intact.

Each file is one self-contained database in WAL mode, checkpointed (`PRAGMA wal_checkpoint(TRUNCATE)`) before it was
closed: no `-wal` or `-shm` belongs next to it. Open a copy, never the file itself. Dates are `1763000000000` unless
said otherwise.

## `legacy-v17.sqlite` (schema version 17)

- Opened by `openDb()`.
- Settings `{ port: 8123, hiddenGpus: ['GPU-1'] }`.
- Profiles `A` (id 1) and `B` (id 2).
- One conversation (id 1) on profile `B`, with two messages: a user `Hello`, then an assistant `Hi there`.

## `legacy-v16.sqlite` (schema version 16)

- `runMigrations(db, 16)` on a new file (WAL, foreign keys on).
- The rows of `rebuilding profiles keeps their ids and every link to them (#38)` (`migrations.test.ts`), dates `1`:
  profiles `a` (id 3) and `b` (id 7), a conversation on profile 7, a sweep on profile 3, a bench run on profile 7.
- Then the steps of `a deleted profile's id is never given to a new profile (#38)` under names of their own (`a` and
  `b` are taken): `c` (id 8), `d` created then deleted (id 9), `e` (id 9 again: schema 16 reuses a deleted id).
