# Effect POC, E10: docs and report

> Milestone validated by the user (spec `docs/superpowers/specs/2026-11-14-effect-server-design.md`, row E10 and "The
> report (E10)"): "`CLAUDE.md` and the developer pages of `site/content/` rewritten for the new server; the measured
> report."

## Where E10 starts

- E0–E9 are committed and green. The Nitro server is gone (`git show 8f6fe3581^:app/server/…`). The baseline numbers
  are `docs/superpowers/poc-effect/baseline.json` (commit `13068280e`, whose server is that of `6327201a3`), and the
  numbers after each milestone are `e1.json`–`e9.json`.
- `CLAUDE.md` still describes Nitro in its body, with one paragraph per milestone (E4–E9) saying what changed. The
  32 developer pages of `site/content/developers/` describe Nitro (`lib/`, `routes/`, `deps()`, zod, `HttpError`,
  `api.gen.ts`, the 405 table, `{ error, code }` bodies).
- The user asked (forwarded note): "compare a few estimates of the old and the new server on your real models".

## Calls

1. **The old server is the baseline tree**, in a scratch worktree at `13068280e`, built there. It is the "before" of
   the measures, of the parity pass and of the estimate comparison.
2. **Measures, back to back**: `scripts/poc/measure.ts` (HEAD's copy) on the baseline worktree, then on HEAD, with the
   durations, on the same machine in the same hour (`defects.md` § Measures: figures taken at different times are not
   comparable). Written as `baseline-e10.json` and `e10.json`; `baseline.json` stays as it was taken at E0.
3. **The parity pass on an existing data directory**: a `.backup` of the user's SQLite (read-only open, never written)
   copied twice in scratch; the old and the new server each started on one copy (free ports, loopback), the user's
   real `~/Modèles` and `llama-server` read, nothing but `GET`s sent (no start, stop, download or deletion; the copy
   has no queued download and no running run or sweep). Every read endpoint of both is compared after a
   normalisation of the volatile fields; each difference is either a recorded decision (`defects.md`) or a defect,
   fixed.
4. **The estimate comparison**: on the same two servers, `POST /api/tuning/estimate` for each real model, every
   preset, with and without pinned args; and `POST /api/tuning/plan` for one. The hardware is read as each server reads
   it (`llama-bench --list-devices`, NVML): a device listing, never a benchmark.
5. **`CLAUDE.md`** is rewritten for the new server: the per-milestone paragraphs are folded into its sections (no
   "since E<N>"), the Nitro sections replaced, `conventions.md` stays the rule book it points to.
6. **The site**: every developer page is rewritten against the code (not against `CLAUDE.md`), the API reference
   against the API definition and the golden (error bodies `{ _tag, message }`, 404 `RouteNotFound` for a wrong method,
   the 308 of a trailing slash, the `pong`). The user pages are checked for a behaviour that changed (the CLI's exit
   code, error messages). Screenshots are not retaken (no visible change; they need the GPUs).
7. **The report**, `docs/superpowers/poc-effect/report.md`: every item of the spec's list, from the measures of Call 2,
   the inventory, `defects.md`, the parity pass and the estimates, with examples from the code.

## Tasks

### Task 1: The old server, the parity pass, the estimates

- [x] Worktree at `13068280e`, `pnpm install --frozen-lockfile --offline`, `pnpm build`.
- [x] Two copies of the user's database; both servers started; the read endpoints compared; differences classified.
- [x] The estimates compared; differences classified.

### Task 2: Measures

- [x] `measure.ts` on the baseline worktree, then on HEAD, with durations: `baseline-e10.json`, `e10.json`.

### Task 3: `CLAUDE.md`

- [x] Rewritten for the new server.

### Task 4: The site

- [x] The developer pages; the API reference; the user pages that name a changed behaviour.
- [x] `pnpm site:build`, `pnpm --dir site check-links`.

### Task 5: The report

- [x] `report.md`.

### Task 6: Close

- [ ] `pnpm lint`, `pnpm check`, `pnpm test`; commit.
- [ ] The app started on a copy of the user's data for the user's validation.
