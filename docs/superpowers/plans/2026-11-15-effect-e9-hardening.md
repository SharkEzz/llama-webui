# Effect POC, E9: hardening

> Autonomous milestone (spec `docs/superpowers/specs/2026-11-14-effect-server-design.md`, row E9): "Full contract
> golden frozen, lifecycle/build/dev/packaging suites complete, `app/server-legacy/` empty and removed, zod gone, the
> three rules lowered for the POC and the test-code override of the Effect diagnostics settled, CI."

## Where E9 starts

- Every entry of `test-inventory.json` is `ported`, `rewritten` or `dropped` (E1–E8), or `keep` (web, shared,
  `llamacpp-js`, scripts). The lifecycle, build and dev suites already grew with their domains (SIGTERM during a
  reply, a benchmark, a download; the monitor's programs; an exit without finalizers; the dev loop with llama-server).
- `app/server-legacy/` still holds 45 files: the three Nitro suites (`lifecycle`, `build`, `dev`), the legacy contract
  (`lib/contract/`, its `golden.json`) and what they import (`lib/testing/`, `lib/db/`, `lib/models/gguf.ts`…).
- The contract replays 134 cases, written by hand per milestone. The legacy one replayed 498: a matrix over its route
  table (each method a path lacks, the six broken bodies of each route with a body, a bad and an unknown id of each
  `:id`, `HEAD` of each `GET`), the guard's cases, and the cases that hold a connection (the WebSocket's hello and
  pong, a fake llama-server started, the chat's SSE stream, the server stopped).
- zod has no import left; it is still a dependency of `app` and `@llama-webui/shared`, and in the catalog.
- The three rules lowered for the POC (commit `6327201a3`): `ignoreEffectWarningsInTscExitCode` (removed at E1),
  `unstableApiUsage` (off: the spec keeps it off), `schemaClassMissingBrand` (a warning "until the server is migrated").

## Calls

1. **The full golden is the matrix again, derived from the API definition** (`HttpApi.reflect`), not from a route
   table: every path's missing methods (`other`), every payload's broken bodies (`body`: malformed JSON, a JSON that is
   not an object, no body with and without a JSON content type, `text/plain`), every `:id`'s bad id (`violation`) and
   unknown id (`refusal`). The hand-written cases stay: they carry the domain's intent. The guard gets the legacy
   cases it lost (same Origin, `Host: localhost`, a malformed Host, a foreign Origin on a write, a deep URL under a
   foreign Host, `POST /ws` without an upgrade).
2. **The connection cases come back**, after the HTTP cases: `/ws` hello and ping → pong, then a profile on the
   folder's model and a free port, started on the fake llama-server, its ready state, a conversation, the SSE reply
   (its first event and the name of its last), and the stop. `readSse` comes back to `wire.ts` with its test.
3. "Frozen" means: the golden covers every endpoint and every case kind, and a change to it is a behaviour change
   read in review (`UPDATE_GOLDEN=1`, as before). Nothing else freezes it.
4. `app/server-legacy/` is deleted in one commit, once the contract is complete; the old server stays readable in git
   (`git show 8f6fe3581^:app/server/…`, the commit before E1 parked it). Biome's `!!app/server-legacy` goes;
   `scripts/poc/measure.ts` keeps its rule (it measures any commit's tree, the E0 baseline's included).
5. zod leaves both `package.json` and the catalog.
6. `schemaClassMissingBrand` is settled at `warning`, which blocks like an error (no Effect diagnostic is allowed),
   and its POC comment goes. `unstableApiUsage` and `apiStabilityLeak` stay off (spec). The test-code override is
   settled as it is, after checking every glob of it matches a file.
7. CI: the gate of `ci.yml` is replayed locally, step by step (install from the lockfile, lint, check, test, build,
   smoke, the tarball smoke, the site). Nothing is pushed.

## Tasks

### Task 1: The full contract

- [ ] `wire.ts`: `readSse(base, req, until)` (the legacy `exchange`); its test back in `wire.test.ts`.
- [x] `cases.ts`: the matrix of Call 1, generated from `HttpApi.reflect`; the guard cases.
- [x] `runStreams` of Call 2; `contract.test.ts` runs it after `runContract`.
- [x] `UPDATE_GOLDEN=1`, read the diff; every new reply that differs from the legacy golden is recorded or already is.

### Task 2: Remove the legacy folder and zod

- [x] Delete `app/server-legacy/`; Biome's exclusion; `CLAUDE.md`'s note on the folder.
- [x] zod out of `app/package.json`, `packages/webui-shared/package.json`, the catalog; `pnpm install`.

### Task 3: The diagnostics settled

- [ ] `tsconfig.effect.json`: Call 6.

### Task 4: CI, close

- [ ] The steps of `ci.yml`, locally.
- [ ] `defects.md`: an E9 section; the inventory (`readSse` ported back); `CLAUDE.md`: an E9 paragraph.
- [ ] `pnpm lint`, `pnpm check` (0 `effect(`), `pnpm test`; commit; `e9.json`; a review pass.
