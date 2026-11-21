# Nitro migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the Nitro v3 slice of `spike/nitro` to `master`: one `app/` package, H3 file routes, `/ws` on crossws,
the production build in `app/.output/`, the npm package and the docs, with the behaviour of today's `master`.

**Architecture:** The branch starts from the spike's history replayed onto `master`; the spike already passes the
contract suite (498/498 statuses). The remaining work closes what the spike left out: packaging, the tests that replaced
the plumbing tests, the shutdown test, the two clean-ups asked after the spike (route types from Nitro's hooks, caching),
the unverified points and the documentation. The PR stays a draft until a Nitro release ships the `shutdown` hook
(nitrojs/nitro#5099); its last task swaps the signal handler for that hook.

**Tech Stack:** Node ≥ 26.13, pnpm, Nitro `3.0.261103-rc` (`nitro/vite`), h3 2, srvx, crossws, Vite 8, Rolldown,
Vitest, Biome, TypeScript 7.

**Spec:** `docs/superpowers/plans/2026-11-13-nitro-spike-report.md` (the go/no-go report, conclusion and
"The `shutdown` hook" section), plus the user's decisions of 2026-11-13: go; ignore the `CI`/`TEST` srvx case; look at
Nitro's cache (`https://nitro.build/config/storage#cache`, possibly a middleware); regenerate the route types from a
hook as soon as an API route is touched.

## Global Constraints

- Branch `feat/nitro` from `origin/master` (`1a0dafb`, PRs #76 and #77 merged). The PR is merged by squash.
- `nitro` pinned to an exact version: `3.0.261103-rc` until Task 10, then the first release that has the `shutdown`
  hook.
- `pnpm lint`, `pnpm check` and `pnpm test` green at the end of every task (zero Biome warning), CLAUDE.md rule.
- Code, comments, test names, commits and the PR in English. Commits end with
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- The docs of `site/content/` change in the same PR as the code (CLAUDE.md mapping table): Task 9.
- Manual checks use `http://192.168.0.20:<port>` and a scratch data dir; never the everyday data dir.
- No process is killed without the user's permission (`TaskStop` for our own background tasks).
- Leave `skills-lock.json`, `.agents/skills/nitro/` and `.claude/skills/nitro` untouched and unstaged.
- `packages/llamacpp-js/` and `packages/webui-shared/` do not change.
- Behaviour parity: the contract suite is the judge; a new divergence is a bug unless this plan names it.

## Review Focus

1. **A user's `PORT` in the environment** (common on servers): `llama-webui --port 7900` must listen on 7900, and
   without `--port` on 7860, never on `$PORT`. Nitro reads `NITRO_PORT`/`PORT`. → Task 2, smoke assertion.
2. **Port already taken at startup** in production: master exits with code 1 and a message; the Nitro build must not
   hang or exit 0. → Task 3, test `a second instance on a taken port exits 1`.
3. **Ctrl+C twice in `pnpm dev` with llama-server running**: Vite exits at once, llama-server must not survive
   (`setpriv --pdeathsig KILL` follows the worker thread that spawned it). → Task 7, manual check by the user.
4. **A route file added or deleted while `pnpm dev` runs**: the client types and the 405 table follow without a
   restart. → Task 5, test `a new route file appears in api.gen.ts`.
5. **Installing the tarball on a machine with nothing else**: no `node_modules`, the NVML sampler still starts next to
   the bundle. → Task 2, `smoke.ts --tarball` (already checks the sampler; keep the check on the new layout).

---

### Task 1: Branch from master with the spike's history

**Files:**

- Delete: `app/probe/` (S0 throwaway), its entry in `pnpm-workspace.yaml`
- Modify: `pnpm-lock.yaml` (probe importer removed)
- Create: `docs/superpowers/plans/2026-11-13-nitro-migration.md` (this file, committed first)

**Interfaces:**

- Produces: branch `feat/nitro` whose tree is the spike's minus the probe, on top of `origin/master`.

- [ ] **Step 1: Replay the spike onto master**

```bash
git fetch origin
git switch -c feat/nitro spike/nitro
git rebase origin/master
```

Conflicts come only from #76 (`server/index.ts`: interval on the stack, one loop for SIGINT/SIGTERM) and #77
(`{ ref: false }` in `supervisor.ts`, `bench/server.ts`, `bench/vram.ts`, `supervisor.test.ts`). The spike already
holds both changes under `app/server/lib/`: resolve every conflict by keeping the spike's side (`git checkout --theirs`
during a rebase is the spike), and keep master's new `server/supervisor/supervisor.test.ts` moved to
`app/server/lib/supervisor/supervisor.test.ts` (fix its `testdata` path to `../../../../testdata/...`).

- [ ] **Step 2: Remove the probe**

`git rm -r app/probe`, drop `app/probe` from `packages:` in `pnpm-workspace.yaml`, `pnpm install`.

- [ ] **Step 3: Verify**

Run: `pnpm lint && pnpm check && pnpm build && pnpm test`
Expected: lint and check clean; tests all pass except `scripts/package.test.ts` (2 failures, fixed by Task 2). Note
the build before the tests: Task 3 makes `pnpm test` build by itself.

- [ ] **Step 4: Commit**

```bash
git add -A pnpm-workspace.yaml pnpm-lock.yaml app/probe docs/superpowers/plans/2026-11-13-nitro-migration.md \
  app/server/lib/supervisor/supervisor.test.ts
git commit -m "chore(nitro): Drop the S0 probe, add the migration plan"
```

Push `feat/nitro` and open a **draft** PR "Move the app to Nitro v3" (body: link to the report and this plan).

---

### Task 2: The npm package from `app/.output`

**Files:**

- Modify: `package.json` (root: `bin`, `files`, no `dependencies`, `start`), `app/package.json` (`preview`)
- Modify: `scripts/prepack.ts`, `scripts/package.test.ts`, `scripts/smoke.ts`
- Modify: `pnpm-workspace.yaml` (`catalog:` loses `hono`, `@hono/node-server`, `ws` if still listed)
- Modify: `.github/workflows/ci.yml`, `.github/workflows/release.yml` (only if a command changes)

**Interfaces:**

- Produces: root `bin.llama-webui = "app/.output/llama-webui.mjs"`, `files = ["app/.output"]`; `pnpm start` =
  `pnpm build && node app/.output/llama-webui.mjs`.

- [ ] **Step 1: Write the failing tests** in `scripts/package.test.ts`, replacing the two failing ones:

```ts
test('the root package is the one npm installs', () => {
  expect(root.bin).toEqual({ 'llama-webui': 'app/.output/llama-webui.mjs' });
  expect(root.files).toEqual(['app/.output']);
  expect(root.os).toEqual(['linux']);
});

test('the package has no runtime dependency: the build is self-contained', () => {
  expect(root.dependencies ?? {}).toEqual({});
});
```

- [ ] **Step 2: Run them**: `pnpm exec vitest run scripts/package.test.ts` → FAIL on `bin`/`files`.

- [ ] **Step 3: Implement.** Root `package.json`: `bin`, `files` as above, remove `dependencies`, `start` as in
      Interfaces. `app/package.json` `preview`: `node .output/llama-webui.mjs` (through the launcher, so `--host`/`--port`
      work). `scripts/prepack.ts`: refuse without `app/.output/llama-webui.mjs` (same message style as today).
      `scripts/smoke.ts --tarball`: after `npm install` in the empty prefix, assert `node_modules/` holds only
      `llama-webui` (no dependency), then run the existing checks through `node_modules/.bin/llama-webui`. Add the Review
      Focus 1 check to the smoke run (both modes): start with `PORT=7999` in the environment and `--port <free>`; assert
      `/api/health` answers on `<free>` and nothing listens on 7999.

- [ ] **Step 4: Verify**

Run: `pnpm exec vitest run scripts/package.test.ts && pnpm build && node scripts/smoke.ts && node scripts/smoke.ts --tarball`
Expected: tests pass; both smoke runs end with their success line.

- [ ] **Step 5: Commit** `feat(nitro): Publish the self-contained build from app/.output`

---

### Task 3: Build once for the tests; shutdown and startup tests

**Files:**

- Create: `app/server/testing/build.ts` (Vitest `globalSetup`), `app/server/testing/launch.ts`
- Create: `app/server/lifecycle.test.ts`
- Modify: `vitest.config.ts` (server project `globalSetup`), `app/server/lib/contract/contract.test.ts` (uses
  `launch()`), `app/server/plugins/runtime.ts` (drop the `CI`/`TEST` branch)

**Interfaces:**

- Produces: `globalSetup` that runs `vite build` in `app/` once per Vitest run when `LLAMA_WEBUI_TEST_BUILD !== '0'`
  (CI sets nothing; a developer may set `0` to reuse an existing `.output`).
- Produces: `launch(opts: { dataDir: string; port?: number; env?: Record<string, string> }): Promise<Launched>` with
  `interface Launched extends AsyncDisposable { base: string; port: number; proc: ChildProcess; exited: Promise<number | null> }`.
  It spawns `node app/.output/llama-webui.mjs --host 127.0.0.1 --port <port> --data-dir <dataDir>` with the
  environment **minus `CI` and `TEST`** (srvx installs no signal handler under them: decision of 2026-11-13), polls
  `/api/health`, and on dispose sends SIGTERM and awaits the exit.

- [ ] **Step 1: Write the failing tests** in `app/server/lifecycle.test.ts`:

```ts
test('SIGTERM with the UI open and a reply streaming stops in under 2 s', async () => {
  // seed a profile on testdata/fake/fake-llama-server, start it (POST /api/server/start), open /ws,
  // start a chat reply with FAKE_CHAT_DELAY_MS=2000, then SIGTERM.
  expect(elapsedMs).toBeLessThan(2000);
  expect(exitCode).toBe(0);
  expect(wsCloseCode).toBe(1001);
  expect(sseEndedCleanly).toBe(true); // the reader got `done`, no socket error
  expect(isAlive(llamaPid)).toBe(false);
  expect(savedReply.status).toBe('stopped');
});

test('a second instance on a taken port exits 1', async () => {
  // launch() one, then spawn a second on the same port
  expect(await secondExit).toBe(1); // within 5 s
  expect(secondStderr).toMatch(/7\d{3}|port|EADDRINUSE/i);
});
```

- [ ] **Step 2: Run** `pnpm exec vitest run app/server/lifecycle.test.ts` → FAIL (no `launch()`).

- [ ] **Step 3: Implement** `build.ts`, `launch.ts`; move the spawn/poll code of `contract.test.ts` into `launch()`.
      In `runtime.ts`, the signal handler keeps `await stop()` and loses the `listenerCount` check and `process.exit(0)`.
      If the taken-port test shows a hang or exit 0, make the launcher exit 1: listen for the server's `error`
      (`EADDRINUSE`) the way Nitro surfaces it, print `Port <n> is already in use`, `process.exit(1)`.

- [ ] **Step 4: Verify** `pnpm test` (builds once, then all suites) → all pass; the contract suite still 498/498.
      `ci.yml` runs `pnpm test` before `pnpm build`: it now works as is (the tests build); `smoke.ts` reuses that build.
      `scripts/release.test.ts` already passes (`release.ts` lists `app/package.json`).

- [ ] **Step 5: Commit** `test(nitro): Build once for the suites; shutdown and taken-port tests`

---

### Task 4: Dev loop and build tests (replace `dev.test.ts`, `build.test.ts`)

**Files:**

- Create: `app/server/dev.test.ts`, `app/server/build.test.ts`

**Interfaces:**

- Consumes: the `.output` of Task 3's `globalSetup`; the fake llama-server.

- [ ] **Step 1: Write the tests.**

`app/server/dev.test.ts` (starts `vite dev` in `app/` on a free port with a scratch data dir and the fake binary as
`llamaServerPath`, starts llama-server through the API):

```ts
test('saving a route file keeps llama-server and the boot', async () => {
  expect(after.bootId).toBe(before.bootId);
  expect(after.pid).toBe(before.pid);
});
test('saving business code rebuilds the runtime and stops the old llama-server', async () => {
  expect(after.bootId).not.toBe(before.bootId);
  expect(isAlive(before.pid)).toBe(false);
});
test('one SIGINT stops vite dev and llama-server', async () => {
  expect(await exited).toBe(0);
  expect(isAlive(pid)).toBe(false);
});
```

The edits rewrite `server/routes/api/health.get.ts` and `server/lib/version.ts` with a marker and restore them in
`finally` (same method as the report's `measure.mjs`).

`app/server/build.test.ts`, on `app/.output` (ports master's `server/build.test.ts` assertions to the new layout):

```ts
test('the client is split per page and three.js lives only in Topology chunks', ...);
test('the client bundle imports no node:* module', ...);
test('the server bundle imports nothing but node:* builtins', ...); // walks .output/server/**/*.mjs
test('the NVML sampler starts from the bundle', ...); // fork .output/server/nvml-worker.mjs, expect its first message
```

- [ ] **Step 2: Run** `pnpm exec vitest run app/server/dev.test.ts app/server/build.test.ts` → pass (these pin
      behaviour the spike already has; a failure is a bug to fix in this task).

- [ ] **Step 3: Commit** `test(nitro): Dev reload and build output tests`

---

### Task 5: Route types from Nitro's hooks

The spike generates `server/api.gen.ts` from a Vite plugin (`buildStart` plus a watcher) and its own file scan
(`walk()`, `routeOf()` in `app/scripts/gen-api.ts`). Findings on `3.0.261103-rc` and on Nitro's `main`: `createNitro()`
scans the handlers before `build:before`, which fires once (dev start and every build); Nitro rescans on a route file
added or deleted, but **no hook runs after that rescan** (`dev:reload` is not called by the Vite builder). So:

- the source of truth becomes **Nitro's scan** (`nitro.scannedHandlers`: `route`, `method`, `handler`), read in
  `build:before`; our filename parser goes;
- in dev, the regeneration on save stays a watcher on `server/routes/api/`, registered by the same module. On `change`
  it regenerates at once (Nitro does not rescan on a change, its list is current). On `add`/`unlink` it waits for
  Nitro's rescan, which **reassigns** `nitro.scannedHandlers` (`scanHandlers()`): it polls for a new array reference
  every 20 ms, up to 2 s, then regenerates (after 2 s it logs a warning and regenerates anyway);
- `Body` / `Query` detection stays a read of the route file (`export type Body` / `export type Query`), so a save that
  adds or removes one also regenerates.

**Files:**

- Create: `app/build/apiTypes.ts` (moves `render()` and the Body/Query read from `app/scripts/gen-api.ts`)
- Delete: `app/scripts/gen-api.ts` (the `--check` mode moves into `api.gen.test.ts`)
- Modify: `app/vite.config.ts`, `app/server/api.gen.test.ts`

**Interfaces:**

- Produces: `apiRoutes(handlers: NitroEventHandler[], serverDir: string): FileRoute[]` (filters `route` starting with
  `/api`, `method` set, `middleware` not set; reads each `handler` file for Body/Query), `render(routes: FileRoute[]):
  string` (unchanged output format), `apiTypes(): { hooks: Partial<NitroHooks>; plugin: Plugin }`, wired as
  `plugins: [apiTypes().plugin, …]` and `nitro.hooks['build:before']`.
- `FileRoute` keeps `{ method; path; file; body; query }`; `ROUTES` and `Api` in `api.gen.ts` keep their shape, so
  `src/lib/api.ts`, `allowTable()` and the contract route test do not change.

- [ ] **Step 1: Write the failing tests** in `app/server/api.gen.test.ts`:

```ts
test('the generated map is Nitro’s own route table', async () => {
  // createNitro({ rootDir: app, serverDir: './server', ignore: ['lib/**'] }) from 'nitro/builder'
  expect(render(apiRoutes(nitro.scannedHandlers, serverDir))).toBe(readFileSync(OUT, 'utf8'));
});
test('a new route file appears in api.gen.ts', async () => {
  // dev server on a free port; write server/routes/api/zz-probe.get.ts returning reply({ ok: true });
  // poll api.gen.ts for 'GET /api/zz-probe' (≤ 3 s); delete the file; poll for its removal. finally: delete.
});
```

- [ ] **Step 2: Run** `pnpm exec vitest run app/server/api.gen.test.ts` → FAIL (`apiRoutes` missing).

- [ ] **Step 3: Implement** `app/build/apiTypes.ts` and the wiring. The file is written only when its text changes
      (the dev worker reloads on every write). Keep `app/build/` out of both TS projects' `include` only if it breaks one;
      it belongs with `vite.config.ts` (Node types).

- [ ] **Step 4: Verify** `pnpm check && pnpm exec vitest run app/server/api.gen.test.ts` → pass; `git status` shows
      `api.gen.ts` unchanged.

- [ ] **Step 5: Commit** `refactor(nitro): Generate the route types from Nitro's scan and build hook`

---

### Task 6: Caching

Inventory of what the app caches, and the decision for each (Nitro's cache is ocache: `defineCachedFunction`,
`defineCachedHandler`, `cache` route rules, storage from the `cache` config):

| What                                                                             | Where                                   | Decision                                                                                                                                                      |
| -------------------------------------------------------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `index.html` revalidated on every load (`no-cache`)                              | `response` hook in `plugins/runtime.ts` | **Move to a middleware**, `server/middleware/02.cache.ts`                                                                                                     |
| Hashed assets `immutable`                                                        | Nitro's public assets                   | Keep (native)                                                                                                                                                 |
| Parsed GGUFs, LRU of 8 by path and part stamps                                   | `lib/models/gguf.ts`                    | Keep: `nitro/cache` resolves `#nitro/virtual/cache`, so `lib/` and its unit tests could not import it, and the key is a file stamp the caller computes anyway |
| `--help` flags per binary, failure not cached                                    | `lib/supervisor/flags.ts`               | Keep (same reason; ten lines)                                                                                                                                 |
| `--version` and `--list-devices` per binary and mtime, last good list on failure | `lib/bench/hardware.ts`                 | Keep: ocache has no "serve the last good value when the refresh fails"                                                                                        |
| GGUF summaries across restarts                                                   | SQLite `model_cache`                    | Keep: persistent, pruned with the scan                                                                                                                        |
| API responses                                                                    | —                                       | None: live local data; no `defineCachedHandler`, no `cache` route rule, no `cache` config                                                                     |

**Files:**

- Create: `app/server/middleware/02.cache.ts`
- Modify: `app/server/plugins/runtime.ts` (remove the `response` hook)
- Test: `app/server/lifecycle.test.ts` (a `describe('HTTP cache')` using `launch()`)

**Interfaces:**

- Produces: middleware `defineMiddleware(async (event, next) => …)`: awaits `next()`, and on a response whose
  `content-type` starts with `text/html` and that has no `cache-control`, sets `cache-control: no-cache`. If h3's
  middleware cannot see the SPA fallback's response (Nitro may serve it outside the middleware chain), keep the
  `response` hook and record why in its comment: the test decides.

- [ ] **Step 1: Write the failing test**

```ts
test('pages are revalidated, hashed assets are immutable, the API sets no cache header', async () => {
  expect((await get('/')).headers.get('cache-control')).toBe('no-cache');
  expect((await get('/chat/12')).headers.get('cache-control')).toBe('no-cache');
  expect((await get(firstAssetPath)).headers.get('cache-control')).toMatch(/immutable/);
  expect((await get('/api/health')).headers.get('cache-control')).toBeNull();
});
```

It passes today through the hook: first remove the hook and see it fail on `/`, then add the middleware.

- [ ] **Step 2: Implement, run** `pnpm test` → pass, contract suite unchanged.

- [ ] **Step 3: Commit** `refactor(nitro): Set the page cache header in a middleware`

---

### Task 7: The points the spike did not verify

**Files:**

- Modify: `app/vite.config.ts` or `app/server/plugins/runtime.ts` (only if `.env.local` is read)
- Test: `app/server/dev.test.ts`

- [ ] **Step 1: `.env.local`.** Add to `dev.test.ts`:

```ts
test('dev reads .env only, not .env.local', async () => {
  // app/.env.local sets LLAMA_WEBUI_DATA_DIR=<tmp2> (deleted in finally); the dev server is started with <tmp1>.
  expect(existsSync(join(tmp1, 'llama-webui.db'))).toBe(true);
  expect(existsSync(join(tmp2, 'llama-webui.db'))).toBe(false);
});
```

If it fails, Nitro loads `.env.local`: turn Nitro's env-file loading off with its config option (search
`NitroOptions` in `nitro/types` for the dotenv / env-file option). If no option exists, stop and ask the user: the
alternative is to document `.env.local` in CLAUDE.md and `docs/configuration.mdx`.

- [ ] **Step 2: Double Ctrl+C in dev (Review Focus 3).** Ask the user to run, in their terminal: `pnpm dev` with a
      scratch `LLAMA_WEBUI_DATA_DIR`, start llama-server from the UI, press Ctrl+C twice quickly, then
      `pgrep -fa llama-server`. Expected: nothing. If llama-server survives, the supervisor's `pdeathsig` does not follow
      the worker thread: report to the user before changing anything.

- [ ] **Step 3: Commit** (if code or tests changed) `test(nitro): Dev reads .env only`

---

### Task 8: The golden becomes Nitro's

**Files:**

- Rename: `app/server/lib/contract/golden.nitro.json` → `golden.json` (replacing master's)
- Modify: `app/server/lib/contract/contract.test.ts` (`GOLDEN` default `golden.json`, header comment)

- [ ] **Step 1:** `git mv -f golden.nitro.json golden.json`, set the default, update the comment (the three accepted
      divergences: `Host a b` JSON 400, `text/html; charset=utf-8` with the real page, h3's SSE `cache-control`).
- [ ] **Step 2: Verify** `pnpm exec vitest run app/server/lib/contract/contract.test.ts` → 498 cases, no diff.
- [ ] **Step 3: Commit** `test(nitro): Nitro's record is the contract golden`

---

### Task 9: Documentation

**Files:**

- Modify: `CLAUDE.md` — sections "Installation (pnpm)" (`hono`/`ws` paragraph goes), "APIs" (HTTP: Nitro, srvx, file
  routes, crossws, SSE through h3's event stream), "Routes API" (file routes under `app/server/routes/api/`, helpers
  `idParam`/`readBody`/`readJson`/`queryOf`, `reply<T>()`, `export type Body`/`Query`, generated `api.gen.ts` and the
  `api('METHOD /api/path', …)` client), "Testing" (`provideDeps()`, `routeApp()`, the build `globalSetup`, the
  contract suite against the build), "Type checking" (the two projects of `app/`), "Frontend" (`vite dev` with Nitro,
  the runtime registry and what survives a save, the `.output` layout, the launcher, distribution), the redeploy
  paragraph, and every path of the code → pages table (`server/…` → `app/server/lib/…` or `app/server/routes/…`,
  `web/src/…` → `app/src/…`).
- Modify (site, `site/content/`): `developers/architecture.mdx`, `developers/frontend.mdx`,
  `developers/getting-started.mdx`, `developers/api/overview.mdx`, `developers/api/websocket.mdx`,
  `developers/server/security.mdx`, `developers/server/supervisor.mdx`, `developers/contributing/conventions.mdx`
  (the tools table), `developers/contributing/testing.mdx`, `docs/configuration.mdx`, `docs/security.mdx`,
  `docs/getting-started/installation.mdx` (package without dependencies).

- [ ] **Step 1:** Write the changes. Every path named in the docs must exist (`git ls-files` it).
- [ ] **Step 2: Verify** `pnpm site:build && pnpm --dir site check-links && pnpm test` → pass (the site tests include
      `nav.test.ts`).
- [ ] **Step 3: Commit** `docs(nitro): CLAUDE.md and the site for the Nitro app`

---

### Task 10: The `shutdown` hook (when Nitro releases it)

Blocked until `pnpm view nitro versions` lists a version whose `dist/types` declares `shutdown` in
`NitroRuntimeHooks` (nitrojs/nitro#5099).

**Files:**

- Modify: `app/package.json` (`nitro` exact new version), `pnpm-lock.yaml`, `app/server/plugins/runtime.ts`

- [ ] **Step 1:** Bump `nitro`, `pnpm install`, `pnpm check`, `pnpm test` (the lifecycle test is the gate).
- [ ] **Step 2:** Replace the signal handler of `runtime.ts` with
      `nitroApp.hooks.hook('shutdown', ({ waitUntil }) => waitUntil(stop()))`; keep the `close` hook (development).
- [ ] **Step 3: Verify** `pnpm test`: `SIGTERM … stops in under 2 s` passes without the handler; the contract suite
      is still 498/498. Re-run `node scripts/smoke.ts --tarball`.
- [ ] **Step 4: Commit** `refactor(nitro): Undo the runtime in Nitro's shutdown hook`, update the PR body, mark it
      ready for review.
