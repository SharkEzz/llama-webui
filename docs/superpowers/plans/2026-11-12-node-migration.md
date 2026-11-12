# Plan — port llama-webui from Bun to Node.js 26 + pnpm

Approved by the user on 2026-11-12 after a brainstorming session. This document is the roadmap and the design brief;
it is written to be executed by someone who did not attend that session. Companion file:
[`2026-11-12-node-migration-notes.md`](./2026-11-12-node-migration-notes.md) (spike findings, refactoring backlog,
contract divergences).

## How to use this document

- Work on the long-lived branch **`node`** (created from `master` at 6ad7d76). One PR per milestone **into `node`**;
  `node` is merged into `master` only at the end (N13). `master` is protected.
- Start with **N0** (the spike). Its answers can change later milestones: record them in the notes file before N1.
- At the start of each milestone, write a detailed task plan from the milestone section below (skill
  `superpowers:writing-plans`), then implement it. A milestone is closed only when its quality gate is green.
- `CLAUDE.md` still applies in full. Its Bun instructions remain true until N8 (the app runs on Bun through N7). Update
  `CLAUDE.md` in every milestone that changes one of its rules: it is the working instruction set for the next one.
- **The port is behaviour-identical.** No refactoring, no optimisation, no behaviour fix beyond what the decisions
  below require. When you notice something worth improving, add it to the notes file and move on.
- The HTTP contract (paths, status codes, error `code`s, English validation messages) must not change: the API
  reference in `site/content/developers/api/*.mdx` is hand-written, and the N5 golden file enforces it.
- If a spike criterion fails even with its fallback, or a milestone needs a decision listed as open, stop and ask the
  user.

## Context

llama-webui runs on Bun 1.4.4: one process serves the HTTP API (~61 paths, ~70 handlers), the `/ws` WebSocket and the
React UI, and supervises `llama-server`. Bun is the runtime, the bundler (HTML import, `Bun.build`), SQLite
(`bun:sqlite`), the NVML FFI (`bun:ffi`), the test runner, the package manager and the standalone binary
(`--compile`).

On 2026-11-11 the user had decided to stay on Bun. On 2026-11-12 they reopened that decision for four reasons: runtime
reliability, standard tooling (Vite, Vitest, pnpm), easier adoption by contributors, and a single target instead of
the Bun + Node double compatibility of `llamacpp-js`.

Target: no trace of Bun anywhere (app, scripts, site, CI, docs), same HTTP contract and product behaviour except what
the decisions below change, then separate refactoring milestones.

Sizes for scale: `server/` 16.4k LOC, `web/src` 17.5k, `packages/webui-shared/src` 2.5k, `site/src` 5.3k. 72 test
files (64 `bun:test`, 8 `node:test` in `llamacpp-js`).

## Decisions (do not re-litigate)

| Topic | Decision |
| --- | --- |
| Runtime / packages | Node 26 (`engines.node >= 26.13`; installed: 26.13.0), pnpm 12 workspace (installed: 12.19.0); `site/` joins the workspace (one lockfile, `catalog:`) |
| TS toolchain | Everything goes through Vite/Rolldown (dev, tests, build). Source keeps extensionless imports, `moduleResolution: bundler`, parameter properties (25 files) and the `@/` alias. Native type stripping only for standalone scripts (`server/dev.ts`, `scripts/`, `site/scripts/`, `testdata/fake/`, the NVML worker in dev). Node 26.13 has no `--experimental-transform-types`: those files must be erasable TS with `.ts` import extensions |
| Dev | One process, one port, server modules hot-reloaded through Vite without killing llama-server (`globalThis` singletons kept) |
| HTTP | Full Hono adoption: chained routes, middleware, `@hono/zod-validator`, typed RPC client (`hc`) in `web` replacing the `api<T>()` call sites |
| WebSocket | Raw `ws` library (`noServer`), same hub (`server/ws/hub.ts`) |
| SQLite | Built-in `node:sqlite`, behind a wrapper that keeps the `bun:sqlite` surface in use |
| NVML | Built-in `node:ffi` (experimental) in a `worker_threads` worker; the nvidia-smi fallback stays |
| Tests | Vitest 5 for the 64 `bun:test` files; `llamacpp-js` keeps `node:test`; its Bun replay and its "and Bun" target claim go away |
| Distribution | No standalone binary. npm-shaped package (`bin: llama-webui`, `dist/`), **not published** for now but kept publishable. A GitHub release carries the `pnpm pack` tarball + `SHA256SUMS`, installed with `npm install -g <tarball URL>` |
| `llamacpp-js` | Stays a workspace package, bundled into the app; its rules do not change |
| Git | Long-lived branch `node`, one PR per milestone into it |
| Refactoring | Out of the port: dedicated milestones afterwards; candidates are recorded in the notes file |

Defaults taken without asking (the user saw them and did not object; revisit only with a reason):

- Package dependencies: npm dependencies (hono, `@hono/node-server`, `ws`, zod, `@huggingface/gguf`) stay external and
  declared; the two workspace packages are bundled. N0(d) also measures the zero-dependency variant
  (`noExternal: true` + `build.license`); decide on its results.
- A divergence between the hand-written API docs and the real behaviour revealed by the contract suite: fix the docs,
  log the divergence, do not change behaviour during the port.
- Hono pinned to 4.13.x (v5 is at rc: refactoring candidate).

## Verified facts that shape the design

Checked on this machine or against current docs/source during planning.

1. **`node:ffi`** (Node 26.13): signatures are `{ arguments: [...], return: 'int32' }`. Pointers are **bigint**; a
   `Number` is rejected ("Argument 0 must be a buffer, an ArrayBuffer, a string, or a bigint"). A `Buffer` is accepted
   for a `'pointer'`/`'buffer'` parameter. Real NVML was called successfully from a `worker_threads` worker here
   (init, driver version, 2 GPUs, name, temperature, shutdown all returned 0).
   `new Worker(url, { execArgv: ['--disable-warning=ExperimentalWarning'] })` silences the warning for that worker
   only. Bun does **not** have `node:ffi`.
2. **`node:sqlite`** is Stability 1.2 (release candidate), loads without a warning. The class is `Database`
   (`DatabaseSync` is a deprecated alias). Defaults: `enableForeignKeyConstraints: true`, `defensive: true`. Rows are
   null-prototype objects. `.get()` returns `undefined`. There is no `transaction()` helper. **`prepare()` silently
   ignores trailing statements** of a multi-statement SQL string. `undefined` binds as NULL (≥ 26.10), booleans bind
   (≥ 26.8). Bun 1.4.4 also ships `node:sqlite`, so this port is verifiable before the runtime flip.
3. **pnpm ≥ 11**: `onlyBuiltDependencies` is gone; it is `allowBuilds:` (a map) in `pnpm-workspace.yaml`.
   `strictDepBuilds` defaults to `true`: an unlisted build script **fails** the install. Settings live in
   `pnpm-workspace.yaml`; `.npmrc` only carries auth/registry. `catalog:` and `workspace:` are rewritten on pack.
4. Bun already installs the root workspace in an isolated, symlinked layout (`node_modules/.bun/…`), the same topology
   as pnpm's. Running Bun on a pnpm tree during N1–N7 is low risk for the app; phantom-dependency risk sits in
   `site/` (flat today).
5. **`@hono/vite-dev-server` is not used**: it loads the app with `ssrLoadModule(entry)` lazily per request, sends a
   browser full-reload on server changes, and has no WebSocket handling.
6. Vite 8's module runner, on `full-reload`, clears its evaluated modules and **re-imports the entrypoints
   immediately**: eager re-evaluation of `server/index.ts` needs no custom watcher (to confirm in N0(a)).
7. Vite 8.3.x: `server.ws: { server?: HttpServer }`; its upgrade listener only takes sockets whose
   `sec-websocket-protocol` is `vite-hmr`/`vite-ping`. `/ws` and HMR can share one `http.Server`.
8. `@hono/node-ws` 1.3.1 peers `@hono/node-server ^1.19` while node-server is at 2.x; node-server's own
   `upgradeWebSocket` only works when its `serve()` owns the server, which is not the case under Vite. Hence raw `ws`.
9. `@hono/node-server` gives **every non-GET/HEAD request a body stream**. `server/security.ts` tests
   `req.body !== null`, so a body-less `DELETE`/`POST` without a content-type would become a 415. The guard must
   detect a body from `content-length` / `transfer-encoding`.
10. Hono matches in **registration order**, not by specificity, and dispatches HEAD to GET routes.
    `hono/method-not-allowed` only acts after `next()` when the status is 404 and `c.error` is unset: it cannot
    reproduce today's 405 (issue #37: `GET /api/profiles/import` must not reach `/api/profiles/:id`).
11. Hono's `validator('json')` yields `{}` when the content-type is not JSON and throws
    `HTTPException(400, 'Malformed JSON in request body')` on bad JSON. `zValidator`'s hook receives
    `{ success, error, data, target }`. `@hono/zod-validator` 0.9.x supports zod 4.
12. Hono RPC inference needs: every route chained, `app.route()` results chained, handlers inline, `c.json()` for
    outputs, validators for inputs. `notFound`/`onError` are not typed. Params and query are strings. Hono's perf
    advice for large apps: project references, compile first, split clients.
13. **Vitest 5.1**: un-awaited `resolves`/`rejects` **fail the test**; `clearMocks` defaults to `true`; `%p` is not a
    supported `test.each` specifier; timeout as numeric third argument and `test.skipIf` work.
14. Versions at planning time: hono 4.13.18, `@hono/node-server` 2.1.7, `@hono/zod-validator` 0.9.1, ws 8.22.2,
    vite 8.3.8, vitest 5.1.0, `@vitejs/plugin-react` 6.3.0, typescript 7.0.2 (`tsc -b --dry` lists the 6 projects).
15. Node has no global `Worker` (use `node:worker_threads`) and no WebSocket server. Node's HTTP defaults do not cut
    an SSE response (`server.timeout` is 0; `requestTimeout` covers receiving the request only).

Not verified yet (each is assigned to a spike item or milestone below): that the default `ssr` environment emits
`full-reload` on a server change; that files outside Vite's `root` are watched once imported by the runner; that
middleware mode installs no signal handlers; exact `environments.ssr.resolve.noExternal` / multi-input config keys;
that Rolldown leaves `node:ffi` external; `tsc -b` wall time and declaration-emit errors here (TS7056/TS2742 on the
Hono app type); whether `bun check -b` and `tsc -b` report the same set; Bun's `node:sqlite` parity with Node's on
binding rules and `defensive`; which dependencies carry install scripts; whether `pnpm pack` packs a `private: true`
package; Node's HEAD and body-less request behaviour against Bun's; whether `ws.send()` on a closing socket can throw;
whether Vitest's transform leaves `using` native.

## Inventory (what exists today)

- **HTTP**: `server/app.ts:62-95` builds one `Bun.serve({ routes, websocket })` from 12 factories in
  `server/routes/*.ts` returning `{ '/api/x/:id': { GET: guarded(fn) } }`. `server/http.ts`: `Handler = (req:
  BunRequest, server) => Response`, `guarded()` (runs `guard(req)` from `server/security.ts`, maps exceptions through
  `errorResponse`), `idParam()` (21 sites), `withMethodNotAllowed()` (405 + `Allow`). Precedence relied on: exact >
  `:param` > wildcard (`/api/profiles/import` vs `/api/profiles/:id`, `/api/bench/run` vs `/api/bench/:id`,
  `/api/downloads/clear` vs `/api/downloads/:id`, `/api/*` 404 vs `/*` SPA fallback). One SSE stream
  (`server/routes/chat.ts:24-51`, `server.timeout(req, 0)`, 3 routes). `req.signal` in `server/routes/hf.ts:28,37`.
  Validation mostly happens inside repos (`profiles.create(await req.json())` parses with zod) plus 8 route-level
  `Schema.parse` sites and some imperative checks with custom messages.
- **WebSocket**: `server/ws/hub.ts`, a `Map` of `ServerWebSocket`, manual broadcast loop (`JSON.stringify` once),
  JSON ping/pong heartbeat every 15 s, `close(4000)` after 2 missed pongs, no pub/sub, no backpressure handling.
- **SQLite**: `server/db/open.ts` (the only value import of `bun:sqlite`) + 8 repos + `migrations.ts`: ~40
  `db.query(sql).get/all/run(...varargs)` (Bun caches statements; `.get()` returns `null`), ~32 `db.run(sql,
  [params])` reading `.changes`/`lastInsertRowid`, 7 `db.transaction(fn)()` (one returns a value), 2 `prepare`, 8
  `RETURNING` reads. `migrations.ts:179-193` toggles `PRAGMA foreign_keys` outside the transaction for table rebuilds.
- **FFI**: `server/collectors/nvml/symbols.ts` (dlopen `libnvidia-ml.so.1`, 25 symbols, all return i32, args
  ptr/u32), `read.ts` (out-params are `Buffer.alloc(n)`; handles read as u64 → `Number`; structs decoded at fixed
  offsets), `worker.ts` (Web-Worker style `self.onmessage`/`postMessage`), `monitor.ts` (`workerUrl()`, `new
  Worker(url)`, `unref`, injectable `WorkerLike`; resolves `null` on error or 3 s timeout →
  `server/collectors/registry.ts:58-59` falls back to nvidia-smi).
- **Processes / files**: 10 `Bun.spawn` (`server/supervisor/supervisor.ts:143`,
  `server/bench/{server,execute,hardware,vram}.ts`, `server/collectors/{membw,nvidia}.ts`,
  `server/tuning/sysinfo.ts`, `scripts/smoke-binary.ts`): stdout/stderr as `ReadableStream` read with `for await` or
  `new Response(stream).text()`, `proc.exited`, `exitCode`/`signalCode`/`pid`, `kill('SIGTERM'|'SIGKILL')`, one with
  `timeout` + `killSignal`; `membw`/`nvidia` take an injectable `spawn` with a structural `Spawned` type. 23
  `Bun.file` (mostly `.text()` on `/proc` and `/sys` with `.catch(() => '')`; range reads `.slice(a, b).stream()` in
  `server/tuning/disk.ts:25` and `server/hf/downloader.ts:464`), 10 `Bun.sleep`, 3 `Bun.which`, 2 `Bun.CryptoHasher`,
  4 `Bun.argv`, `import.meta.dir` ×3, `import.meta.main` ×1, global `Timer` type ×2, 1 `Bun.$`, 1 `Bun.spawnSync`.
- **Web build**: `import index from '../web/index.html'` (`server/index.ts:1`); `Bun.build` in memory at startup in
  `start` mode (`server/routes/web.ts`: splitting, minify, `publicPath: '/'`, `define` NODE_ENV; outputs become routes
  with `Cache-Control: public, max-age=31536000, immutable`; HTML as `/*` with `no-cache`; 503 plain text if the build
  fails; no gzip, no ETag); `bunfig.toml` `[serve.static] plugins = ["bun-plugin-tailwind"]`. `web/`: Tailwind 4
  CSS-first (`web/src/index.css`), `@/*` alias declared only in `web/tsconfig.json` (≈540 imports), 14 lazy routes via
  literal `import()`, 20 shiki dynamic imports, `import.meta.hot` once (`web/src/lib/ws.ts:95`), no `public/` dir,
  favicon referenced from `index.html`, client uses relative `/api` and `ws(s)://${location.host}/ws`.
- **Hot reload**: four `globalThis` singletons — `__llamaWebuiRuntime` (`server/runtime.ts:18-37`: supervisor, log
  ring, bootId, monitor promise, bench gate; installs SIGINT/SIGTERM/exit handlers once), `__llamaWebuiDispose`
  (`server/index.ts:35-36,172-190`), `__llamaWebuiPlacement` (`server/monitor/placement.ts`),
  `__llamaWebuiDownloadHandover` (`server/hf/downloader.ts:22-24`). Errors are recognised by `name`, not `instanceof`
  (`isHttpError`), because classes can come from an older module copy.
- **Standalone binary**: `scripts/compile.ts`, `scripts/smoke-binary.ts`; `Bun.isStandaloneExecutable` in
  `server/index.ts:59`, `server/cli.ts:21`, `server/collectors/nvml/monitor.ts:22`; `LLAMA_WEBUI_VERSION` define read
  in `server/version.ts`.
- **Tests**: Jest-style `expect` everywhere; 3 `mock()` (`server/hf/downloader.test.ts`), 4 `test.each` with
  `%s`/`%p` (`site/src/lib/theme.test.ts`), 1 `test.skipIf` on a local `/tmp` file (`server/db/sweeps.test.ts:35`),
  no snapshots, no DOM, 51 `using`, 10 per-test timeouts. 21 files call `Bun.*` directly (`Bun.write` 60×,
  `Bun.sleep` 29×, `Bun.file` 19×, `Bun.serve` 2× in `server/routes/routes.test.ts`, `Bun.$` 2×). Four un-awaited
  `.rejects` in `server/models/gguf.test.ts:164,168,174,220`. `server/routes/web.test.ts` runs the real `Bun.build`.
  `testdata/fake/fake-llama-server` and `fake-llama-bench` are `/bin/sh` wrappers doing `exec "${BUN_PATH:-bun}"
  x.ts`; their `.ts` use `Bun.serve`, `Bun.file`, `Bun.sleep` and are covered by no tsconfig project.
- **Tooling**: `bun check --no-script -b` on TypeScript 7.0.2 (root tsconfig is a solution: llamacpp-js, its tests,
  webui-shared, server, scripts, web; `site` checked separately). `typescript` is a root *peer* dependency. Five
  projects set `types: ["bun"]`. Biome 2.6.7 (unchanged by the port). CI: `.github/workflows/{ci,release,
  site-deploy}.yml` on `oven-sh/setup-bun@v2` 1.4.4 (+ Node 24).
- **Site**: Vite 8 + React Router 8 + Tailwind 4 + MDX, own `bun.lock`; `site/scripts/{postbuild,check-links,serve,
  og,screenshots,demo-seed}.ts` use `Bun.serve`, `Bun.Glob`, `Bun.gzipSync`, `Bun.file`, `Bun.write`, `Bun.argv`,
  `import.meta.dir`; 5 `bun:test` files. `site/vite.config.ts` is an in-repo reference for Vite 8 + `@tailwindcss/vite`
  + the `@` alias.
- **Docs**: README (51 mentions of bun), CLAUDE.md (91), 29 of 60 `site/content/**/*.mdx` (388; heaviest:
  `developers/getting-started`, `architecture`, `contributing/{testing,workflow,conventions}`,
  `docs/getting-started/{installation,requirements}`), `site/src/docs/ArchitectureDiagram.tsx` and a few landing
  components. `docs/superpowers/plans/*.md` are historical: leave them.

## Target shape

```
vite.config.ts        one config: client env (root web/ → dist/web), ssr env (→ dist/server), shared alias/define
server/dev.ts         dev launcher, run by plain `node` (erasable TS, imports only vite + node:*)
server/main.ts        prod entry and bin (#!/usr/bin/env node): NODE_ENV ??= 'production', then import './index'
server/index.ts       composition root, unchanged in spirit (side effects, dispose hook, the 4 globals)
server/api.ts         createApi(deps): chained Hono app; exports AppType
server/host.ts        the http.Server: 'request' → /api to Hono, the rest to `web`; 'upgrade' → /ws
server/ws/attach.ts   `ws` adapter around WsHub
server/db/sqlite.ts   node:sqlite wrapper with the bun:sqlite surface the repos use
server/proc.ts        spawn / file / which helpers on node:*
```

Dev and prod share `host.ts`. They differ only in the `web` handler: `vite.middlewares` in dev, an in-memory static
map built once from `dist/web` in prod.

Dev entry (how re-evaluation is triggered):

```ts
// server/dev.ts — outside the reloadable graph
const http = createServer();
const vite = await createViteServer({
  server: { middlewareMode: true, ws: { server: http } }, // HMR socket shares the port
  appType: 'spa',                                          // index.html transform + deep-URL fallback
});
(globalThis as DevGlobals).__llamaWebuiDevHost = { http, web: vite.middlewares };
const ssr = vite.environments.ssr;
if (!isRunnableDevEnvironment(ssr)) throw new Error('ssr environment is not runnable');
await ssr.runner.import(SERVER_ENTRY); // eager; on change the runner clears its cache and re-imports it
```

- `server/index.ts` re-runs top to bottom on every server-file save, as under `bun --hot`. It still starts with
  `g.__llamaWebuiDispose?.()`.
- The four existing globals stay. A fifth, `__llamaWebuiDevHost`, holds the listening socket.
- `host.mount()` swaps its own `request`/`upgrade` listeners on each evaluation and calls `listen()` only the first
  time.
- `runtime.ts` keeps ownership of shutdown (SIGINT/SIGTERM/exit).

## Milestones

Sizes: S ≤ 1 day, M = 2–4 days, L ≥ 1 week.

```
N0 → N1 → N2 → N3 → ┬ N4 ┬→ N6 (a → b,c,d) ┬→ N7 ───────────────┐
                    └ N5 ┘                 └→ N8 → N9 → N11 ────┼→ N12 → N13 → R…
                            N10 (any time after N4) ────────────┘
```

Splittable: N2 (by directory), N4 (by project), N6 (by route file after N6a), N12 (by page).
Parallel pairs: N4 ∥ N5; N7 ∥ N8–N9; N10 ∥ N6–N9.

### N0 — Spike (M, time-boxed 3 days)

Throwaway branch `spike/node-port`, never merged. Output: the "Spike findings" section of the notes file. No gate, no
docs.

| Item | Pass criterion | Fallback |
| --- | --- | --- |
| (a) Dev loop: `server/dev.ts` as above with a stub Hono app, the real `getRuntime()`, and `testdata/fake/fake-llama-server` | Saving a file under `server/routes/` re-runs `index.ts` in < 1 s without a request. The llama-server PID and `bootId` are unchanged. A browser tab keeps HMR, and `/ws` reconnects with the same `bootId`. Editing `packages/webui-shared` updates both sides. A syntax error leaves the old instance serving. Ctrl-C stops llama-server through `runtime.ts`. Files outside Vite's `root` (`server/**`, `packages/**`) are watched. Middleware mode installs no signal handlers of its own | First: explicit `vite.watcher.on('change')` → `ssr.moduleGraph.invalidateAll()` + `runner.clearCache()` + re-import. Second: `rolldown --watch` to a dev bundle, then `import('./server.js?t=…')` in the same process |
| (b) NVML | Largely answered (fact 1). Remaining: the worker as a `.ts` file run by native type stripping, 10 minutes of sampling without a crash, clean `terminate()` | nvidia-smi collector only (already automatic) |
| (c) RPC types: stub 70 chained routes modelled on `profiles.ts`/`bench.ts` with real shared schemas, web → server project reference | `tsc -b` cold and incremental times recorded against today's baseline. No TS7056/TS2742 in declaration emit. A canary in `web` (`const t: number = setTimeout(() => {}, 0)`) still compiles, proving Node globals do not leak. Editor completion on `client.api.…` under ~1 s | Per-domain exported types (`ProfilesApi`…) and per-domain `hc` clients |
| (d) Build shape | `vite build` with `builder: {}` yields `dist/web` (> 10 JS chunks, `WebGLRenderer` absent from the entry chunk, fonts as files) and `dist/server/{main,nvml-worker}.js`. `node dist/server/main.js` boots from a directory outside the repo, serves a deep URL and all its assets; `node:sqlite`/`node:ffi` stay external. Also try `noExternal: true` and record the trade-off | Server built by a small separate `rolldown` config; web stays on Vite |
| (e) Bun on a pnpm tree: in a scratch worktree, `pnpm install`, then today's full gate with Bun | `bun run lint && bun run check && bun test`, `bun run start`, `bun run compile` and the smoke all pass | `nodeLinker: hoisted` until N8; if that fails, fold the lockfile switch into N8 |
| (f) Vitest 5 smoke | One test with `using`, `import … from 'node:sqlite'`, `import.meta.dirname` and a numeric third-argument timeout passes on Node 26 | Pin the transform target |

If (a) or (c) fail even with their fallback, stop and go back to the user before N1.

Recommendation for (d): one Vite 8 multi-environment build rather than a separate bundler, so dev, test and build
share one resolver, alias and `define` configuration. Bundle the two workspace packages
(`noExternal: ['llamacpp-js', '@llama-webui/shared']`; their `exports` point at `.ts`).

### N1 — pnpm workspace, single lockfile (S). Runtime: Bun

- Add `pnpm-workspace.yaml`; delete `bun.lock` and `site/bun.lock`.
- Root `package.json`: `"packageManager": "pnpm@12.19.0"`, `engines.node >=26.13`; `typescript` moves from
  `peerDependencies` to a catalog devDependency.
- `.github/workflows/{ci,site-deploy}.yml`: `pnpm/action-setup` + `pnpm install --frozen-lockfile`; `setup-bun` stays
  for running. `site-deploy.yml` `paths:` gains `pnpm-lock.yaml` and `pnpm-workspace.yaml`. Check that `ci.yml` runs
  on PRs targeting `node`.

```yaml
packages: [packages/*, server, web, site]
catalog:            # only what two or more projects share
  typescript: ~7.0.2
  react: ^19.3.1
  react-dom: ^19.3.1
  react-router: ^8.5.1
  tailwindcss: ^4.3.5
  '@tailwindcss/vite': ^4.3.5
  vite: ^8.3.8
  zod: ^4.6.7
  shiki: ^4.6.0
  '@types/node': ^26.6.6
allowBuilds: {}     # filled from the ERR_PNPM_IGNORED_BUILDS list of the first install
```

For each package pnpm lists, set `true` only if a feature needs its script (sharp for `site og`/`screenshots`, the
Tailwind oxide binary); set the rest to `false`.

Gate (Bun runs, pnpm installs): `bun run lint`, `bun run check`, `bun test`, llamacpp-js `test:node`,
`bun run compile` + `bun scripts/smoke-binary.ts dist/llama-webui`, `bun run site:build` + `check-links`.
Docs: CLAUDE.md (install lines; `site/` no longer has its own lockfile).
Risk: a phantom import in `site/` → declare it. Fallback as in N0(e).

### N2 — Runtime-neutral `node:*` replacements (M, parallelisable by directory). Runtime: Bun

- All `Bun.spawn`, `Bun.file`, `Bun.sleep`, `Bun.which`, `Bun.CryptoHasher`, `Bun.argv`, `import.meta.dir` →
  `import.meta.dirname`, `Timer` → `ReturnType<typeof setInterval>`; the same in the 21 test files (`Bun.write` →
  `writeFile`, …); `scripts/release.ts`.
- `testdata/fake/*.ts` move to `node:http`/`node:fs` (erasable TS, `.ts` import extensions); the wrappers `exec` node.
- Fence the remaining Bun-only access so modules load on Node: `server/standalone.ts` with
  `typeof Bun !== 'undefined' && Bun.isStandaloneExecutable`, used by `cli.ts`, `index.ts`, `nvml/monitor.ts`
  (removed again in N8).

`server/proc.ts` mirrors the Subprocess subset in use, so call sites barely change (`new Response(proc.stdout).text()`
and `for await` both keep working):

```ts
export interface Spawned {
  pid: number;
  stdout: ReadableStream<Uint8Array> | null; // Readable.toWeb(child.stdout)
  stderr: ReadableStream<Uint8Array> | null;
  exited: Promise<number | null>;            // resolves on 'exit'
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  kill(signal?: NodeJS.Signals): void;
}
export function spawnProc(argv: string[], o: SpawnOptions): Spawned;
// stdio ['ignore', o.stdout ?? 'pipe', o.stderr ?? 'pipe']; timeout/killSignal passed through.
// Bun.spawn throws synchronously on ENOENT; Node emits 'error' later with child.pid undefined:
//   if (child.pid === undefined) { child.once('error', noop); throw new Error(`spawn ${argv[0]} ENOENT`); }
// so the `try { spawn } catch { fail(message) }` in supervisor.ts keeps working.
```

Same file: `readText(path)` = `readFile(path, 'utf8')` (the `.catch(() => '')` stays at call sites);
`fileRange(path, a, b)` = `Readable.toWeb(createReadStream(path, { start: a, end: b - 1 }))`; `which(bin)` = PATH scan
with `access(X_OK)`; `createHash('sha256')` replaces `Bun.CryptoHasher`; `setTimeout` from `node:timers/promises`
replaces `Bun.sleep`.

Gate: as N1.
Docs: `developers/server/supervisor.mdx`, `developers/server/security.mdx` (they name `Bun.spawn`),
`developers/server/hugging-face.mdx` (`Bun.file`), `developers/contributing/testing.mdx` (fakes run on Node).
Risks: the launch-failure log text may change (`spawn … ENOENT`): check whether a test or a doc quotes it. `exited` on
`'exit'` vs `'close'` ordering against the pipe readers: the existing supervisor and bench tests are the oracle.

### N3 — `bun:sqlite` → `node:sqlite` (M). Runtime: Bun (which ships `node:sqlite`)

New `server/db/sqlite.ts`; the 9 files of `server/db/`, `app.ts`, `routes/models.ts`, `routes/setup.ts` and two tests
change their import line only.

```ts
import { Database as Raw, type SQLInputValue, type Statement } from 'node:sqlite';
export class Database {
  #raw: Raw; #cache = new Map<string, Statement>(); #depth = 0;
  constructor(path: string) { this.#raw = new Raw(path); }
  query<Row, P extends SQLInputValue[] = SQLInputValue[]>(sql: string) {
    const s = this.#stmt(sql);                                    // cached, as Bun's query()
    return {
      get: (...p: P) => (s.get(...p) as Row | undefined) ?? null, // Bun returns null
      all: (...p: P) => s.all(...p) as Row[],
      run: (...p: P) => s.run(...p) as { changes: number; lastInsertRowid: number },
    };
  }
  prepare<Row, P extends SQLInputValue[]>(sql: string) { /* same shape, uncached */ }
  run(sql: string, params?: SQLInputValue[]) {
    if (params?.length) return this.#stmt(sql).run(...params);
    this.#raw.exec(sql);                                          // may hold several statements (fact 2)
    return this.#stmt('SELECT changes() AS changes, last_insert_rowid() AS lastInsertRowid').get();
  }
  transaction<A extends unknown[], R>(fn: (...a: A) => R) {
    return (...a: A): R => {
      const sp = this.#depth > 0;
      this.#raw.exec(sp ? `SAVEPOINT s${this.#depth}` : 'BEGIN');
      this.#depth++;
      try { const r = fn(...a); this.#depth--; this.#raw.exec(sp ? `RELEASE s${this.#depth}` : 'COMMIT'); return r; }
      catch (e) { this.#depth--; this.#raw.exec(sp ? `ROLLBACK TO s${this.#depth}; RELEASE s${this.#depth}` : 'ROLLBACK'); throw e; }
    };
  }
  close() { this.#cache.clear(); this.#raw.close(); }
}
```

`open.ts` keeps its explicit `PRAGMA foreign_keys = ON` and WAL; `migrations.ts` keeps toggling the pragma outside
the transaction. Add wrapper unit tests: `null` on no row, multi-statement `run`, nested rollback, transaction return
value, `RETURNING` through `get`.

Gate: as N1. Docs: `developers/server/database.mdx`.
Risks: Bun's `node:sqlite` may differ from Node's (make the wrapper strict: never pass `undefined`); null-prototype
rows may fail a `toStrictEqual`; `defensive: true` vs the table-rebuild migrations (`migrations.test.ts` decides; pass
`{ defensive: false }` if it blocks).

### N4 — Vitest + `tsc -b` (M, mechanical). Tests move to Node; the app stays on Bun

From here every milestone is proven on Node as it lands, so N8 flips a code base whose unit tests already pass on the
target runtime.

- Root `vitest.config.ts` with `projects` (server, web with the `@` alias, shared, scripts, site),
  `environment: 'node'`, explicit imports (no globals), `clearMocks: false` if a test relies on mock state.
- The 64 files: `bun:test` → `vitest`; 3 `mock()` → `vi.fn()`; `%p` → `%o`; `test.skipIf` unchanged.
- `await` the four `.rejects` in `server/models/gguf.test.ts:164,168,174,220`.
- llamacpp-js: `"test": "node --test 'tests/*.test.ts'"`; the Bun replay goes; CI runs it on Node 24 and 26.
- `package.json`: `test` = `vitest run && pnpm --filter llamacpp-js test`; `check` = `tsc -b` + the site typecheck.
- Files that boot `Bun.serve` or `Bun.build` (`server/routes/web.test.ts`, `server/routes/routes.test.ts` and any
  other found then, later `contract.test.ts`) stay on `bun:test`, excluded from Vitest and run by an explicit
  `bun test <files>` until N6/N8. Fix the exact list in this milestone.

Gate: `pnpm lint`, `pnpm check`, `pnpm test`, the remaining `bun test` files, `bun run compile` + smoke, site build +
links.
Docs: `developers/contributing/testing.mdx`, CLAUDE.md "Testing" and "Type checking".
Risks: `tsc -b` emits declarations where `bun check` wrote nothing, so TS4023/TS2742-class errors may appear (N0(c)
measures; fallback: keep `bun check` until N8).

### N5 — HTTP contract suite (M). Parallel with N4

A golden record of today's HTTP behaviour, replayed unchanged after N6 and N8.

- `server/contract/cases.ts` (pure data + `runContract(baseUrl)`), `server/contract/golden.json` (committed,
  hand-rolled, not a runner snapshot), `server/contract/contract.test.ts` (boots the real `createApp` on port 0 with
  a temp DB, fake binaries and a stub monitor).
- Cases over **real HTTP** (in-process `app.request()` would hide the runtime differences of fact 9): for each path,
  every method in GET/POST/PUT/PATCH/DELETE/HEAD (405 + `Allow`); bad id and unknown id; for each body route:
  malformed JSON, non-object JSON, no body with and without content-type, wrong content-type (415), one schema
  violation (message + `issues`); body-less `DELETE`/`POST` on the routes the web calls that way; foreign `Origin`
  and bad `Host`; `/api/nope`; a deep SPA URL; `/ws` without upgrade (426); a WebSocket connect (hello, ping → pong);
  an SSE stream against the fake server (headers and first event).
- The file stays on `bun:test` (it boots `Bun.serve`) and moves to Vitest in N8 by changing its import and `boot()`.

Gate: as N4. Docs: `developers/contributing/testing.mdx` (the suite, how to regenerate the golden).
Risk: assembling `AppDeps` without `index.ts`'s side effects; if heavy, extract a `createDeps()` used by both, with a
behaviour-neutral diff. Log every divergence between the API docs and the golden in the notes file.

### N6 — Hono + `@hono/zod-validator`, still served by `Bun.serve` (L, splittable). Runtime: Bun

Split: **N6a** foundation (`server/api.ts`, `server/http.ts` wrappers, health + settings routes), then **N6b–d** three
or four route files each. Each PR stays green because `Bun.serve` keeps
`routes: { ...legacyRoutes, '/api/*': (req, server) => api.fetch(req, { server }), '/ws': …, ...deps.web }`: Bun's
precedence sends not-yet-migrated paths to the old handlers.

```ts
// server/routes/profiles.ts
export const profileRoutes = (deps: ProfileRouteDeps) =>
  new Hono<Env>()
    .get('/api/profiles', (c) => c.json(deps.profiles.list()))
    .post('/api/profiles', body(ProfileInputSchema), (c) => c.json(deps.profiles.create(c.req.valid('json')), 201))
    .post('/api/profiles/import', /* … */)                 // static paths BEFORE '/api/profiles/:id'
    .get('/api/profiles/:id', id('Profile'), (c) => c.json(mustGet(c.req.valid('param').id)))
    .put('/api/profiles/:id', id('Profile'), body(ProfileInputSchema), /* … */);

// server/api.ts
export function createApi(deps: AppDeps) {
  const allow = allowTable();
  const api = new Hono<Env>()
    .use('/api/*', guardMw, allow.mw)                      // guard first, as guarded() does today
    .route('/', healthRoutes())
    .route('/', settingsRoutes(deps)) /* …12 factories… */;
  allow.load(api.routes);
  api.notFound((c) => c.json({ error: 'Unknown route' }, 404));
  api.onError((err) => errorResponse(err));                // existing function, kept verbatim
  return api;
}
export type AppType = ReturnType<typeof createApi>;

// server/http.ts
export const body = <S extends z.ZodType>(schema: S) => every(
  jsonOnly,                                                // content-type not JSON → the 'Invalid JSON' path (fact 11)
  zValidator('json', schema, (r) => {
    if (r.success) return;
    if (!isPlainObject(r.data)) throw new HttpError(400, 'JSON object expected'); // keeps jsonObject()'s message
    throw r.error;                                         // ZodError → errorResponse → 'Invalid data: … (path)' + issues
  }));
export const id = (what: string) => validator('param', (p: { id?: string }) => {
  const n = Number(p.id); if (!Number.isInteger(n) || n <= 0) throw notFound(what); return { id: n };
});
// errorResponse gains one branch: HTTPException 400 'Malformed JSON…' → { error: 'Invalid JSON' }
```

Rules for the port:

- A route that parses with a schema today (8 route-level sites, plus the repo-level parses such as
  `profiles.create`) gets `body(Schema)`. The repo keeps its own parse (no refactor). Add one idempotence test per
  schema: `parse(parse(x))` equals `parse(x)`.
- A route with imperative checks and custom messages (`profileId: expected an integer or null`, `content: expected a
  string`) keeps them inside a `validator('json', fn)`: still typed for `hc`.
- Validator order is `id()` then `body()`, so 404 still beats 400.
- **405**: `allow.mw` is a pre-routing middleware. Among the registered patterns matching the path it takes the most
  specific (static beats `:param`); if the method is not one of that pattern's, it answers 405 with `Allow` in the
  existing `METHODS` order and the body `Method not allowed (…)`.
- **Precedence**: an invariant test walks `api.routes` and fails if a static path is registered after a param pattern
  that shadows it for the same method (`/profiles/import`, `/bench/run`, `/downloads/clear`).
- **SSE**: `sse()` kept as is; `server.timeout(req, 0)` becomes `c.env.server?.timeout(c.req.raw, 0)`, a shim removed
  in N8. `req.signal` → `c.req.raw.signal`.
- **Hub**: `WsHub` types its sockets as `interface WsLike { send(data: string): void; close(code?: number, reason?:
  string): void }` (`ServerWebSocket` satisfies it). `/ws` stays a Bun route for now.
- **Tests**: `routes.test.ts`, `models.test.ts`, `http.test.ts` move to `app.request(...)`; the #37 test stays,
  expressed on `createApi`.
- The repo has a `hono` skill (`.claude/skills/hono`) with the Hono CLI for quick in-process checks; it does not
  replace N5.

Gate: as N5; the contract golden must be **byte-identical**. Any diff is fixed, or brought to the user as an explicit
contract change.
Docs: `developers/api/overview.mdx`, `developers/server/security.mdx`, `docs/security.mdx` (where they name
`guarded()`/`Bun.serve` routes), `developers/contributing/how-to.mdx` ("add a route"), CLAUDE.md (route pattern,
static-before-param rule). `developers/api/<domain>.mdx` only if the golden moved.
Risks: HEAD answered through GET routes (the golden decides); `c.json()` output types (`JSONParsed<T>`) differ subtly
from shared types (surfaces in N7); deep-instantiation errors on long chains (chains are per file already).

### N7 — Typed RPC client in `web` (M–L). Depends only on N6; parallel with N8–N10

- `server/package.json`: `"exports": { "./api": "./api.ts" }`. `web/package.json`: devDependencies
  `@llama-webui/server: workspace:*` and `hono`. `web/tsconfig.json`: `references` gains `../server`.
- `web/src/lib/api.ts` plus its ~60–75 `api<T>()` call sites.

```ts
import { hc } from 'hono/client';
import type { AppType } from '@llama-webui/server/api';  // type-only; verbatimModuleSyntax erases it
export const client = hc<AppType>('/').api;
export async function call<T>(req: Promise<ClientResponse<T>>): Promise<T> {
  /* same mapping as api(): ApiError(status, error, issues, code); network failure → ApiError(0, 'llama-webui server unreachable') */
}
// api<Profile>(`/profiles/${id}`)  →  call(client.profiles[':id'].$get({ param: { id: String(id) } }))
```

- `ApiError`/`apiError` are unchanged. The SSE endpoints keep `readSse` on the raw `Response`.
- Under `tsc -b`, web reads the server's emitted `.d.ts` (`server/.tsbuild/`). Node types stay out because `web` does
  not list `node` in `types`; commit the N0(c) canary as a type test. Add a build assertion that the web bundle
  contains no `node:` specifier.

Gate: as N6. Docs: `developers/frontend.mdx`, `developers/api/overview.mdx`; CLAUDE.md (`references` rule gains
"web → server, types only").
Risks: type fallout at call sites (fix types, never cast to silence); tsc time (apply the N0(c) fallback).

### N8 — Runtime flip (M–L, kept short by N2–N7). Runtime: Node from here

- New: `vite.config.ts`, `server/dev.ts`, `server/main.ts`, `server/host.ts`, `server/ws/attach.ts`,
  `scripts/smoke.ts`. Rewritten: `server/routes/web.ts`. Changed: `server/index.ts` (drop the HTML import,
  `Bun.serve`, the `standalone` branch; end with `host.mount(...)`), `server/app.ts` (folded into `api.ts`/`host.ts`),
  `server/security.ts`, `server/version.ts`, `server/cli.ts` (usage lines). Deleted: `bunfig.toml`,
  `bun-plugin-tailwind`, `scripts/compile.ts`, `scripts/smoke-binary.ts`, `server/standalone.ts`, the `c.env.server`
  shim.
- Dependencies: `vite`, `@vitejs/plugin-react`, `@tailwindcss/vite`, `@hono/node-server`, `ws`, `@types/ws`.

```ts
// server/host.ts
const api = getRequestListener(app.fetch, { overrideGlobalObjects: false }); // keep the real Request/Response
http.on('request', (req, res) => (isApiOrWs(req.url) ? api(req, res) : web(req, res)));

const wss = new WebSocketServer({ noServer: true });
http.on('upgrade', (req, socket, head) => {
  if (pathOf(req) !== '/ws') { if (!dev) socket.destroy(); return; } // dev: Vite's listener owns the rest
  const refused = guard(asRequest(req));                             // same Host/Origin rules
  if (refused) return void socket.end(statusLine(refused));
  wss.handleUpgrade(req, socket, head, (ws) => {
    hub.attach(ws);
    ws.on('message', (d, binary) => !binary && hub.receive(ws, d.toString()));
    ws.on('close', () => hub.detach(ws)); ws.on('error', () => {});
  });
});
```

- Prod `web` handler: exact path → bytes with `Cache-Control: public, max-age=31536000, immutable`; anything else →
  `index.html` with `no-cache`; `dist/web` missing → the existing 503 text. No gzip, no ETag (as today; backlog).
- `guard()` replaces `req.body !== null` with `Number(content-length) > 0 || transfer-encoding` (fact 9).
- Scripts: `dev` = `node server/dev.ts`, `build` = `vite build`, `start` = `pnpm build && node dist/server/main.js`.
- Version: `define: { LLAMA_WEBUI_VERSION }` at build = `git describe --tags --always --dirty`, else the
  `package.json` version when there is no git; `dev` in dev. The `typeof LLAMA_WEBUI_VERSION` check in `version.ts`
  stays.
- `web.test.ts` becomes a Vitest build test (programmatic `vite build` to a temp dir: > 10 chunks, `WebGLRenderer`
  not in the entry, headers through the static map). `contract.test.ts` moves to Vitest and boots `host.ts`.
- NVML: `new Worker` throws on Node → `NvmlMonitor.start` resolves `null` → nvidia-smi collector, until N9.
- CI: `compile` + `smoke-binary` replaced by `pnpm build` + `node scripts/smoke.ts` (help, boot, `/api/health` with
  version ≠ `dev`, deep URL + every referenced asset, production React, WebSocket hello).

Gate (Node only): `pnpm lint`, `pnpm check`, `pnpm test` with the golden identical, `pnpm build` + smoke, site build +
links (site scripts still run on Bun until N10).
Manual: the N0(a) checklist on the real app at `http://192.168.0.20:7860`, with a real model loaded and a server-file
edit while it runs (llama-server must not restart).
Docs: `developers/architecture.mdx` (largest edit), `developers/api/websocket.mdx`, `developers/api/overview.mdx`,
`developers/frontend.mdx`, `docs/security.mdx` + `developers/server/security.mdx` if the guard wording changes, the
"`bun --hot`" paragraphs in `developers/server/{supervisor,database,bench,monitor,chat,hugging-face}.mdx` and
`developers/api/{server,sweeps,chat}.mdx`, `site/src/docs/ArchitectureDiagram.tsx`. CLAUDE.md: remove the Bun
preamble; rewrite "Frontend", the hot-reload trap (same survivor list plus the dev host) and the "new web file" note.
Risks: dev loop (per N0(a)); first-visit dependency re-optimisation reloads (three, shiki) → `optimizeDeps.include`;
the golden differs on Node → fix in `host.ts`/`security.ts`, never in the golden.

### N9 — NVML on `node:ffi` + `worker_threads` (S). Can merge into N8 or follow it

```ts
// symbols.ts
const { functions } = dlopen(path, {
  nvmlInit_v2: { arguments: [], return: 'int32' },
  nvmlDeviceGetHandleByIndex_v2: { arguments: ['uint32', 'buffer'], return: 'int32' },
  nvmlDeviceGetName: { arguments: ['pointer', 'buffer', 'uint32'], return: 'int32' }, // handle: bigint
  /* … 25 symbols; out-params 'buffer' … */
});
// read.ts: handles are bigint: out.readBigUInt64LE(0), no Number()
// worker.ts: parentPort.on('message', …) / parentPort.postMessage(…)
// monitor.ts
const w = new Worker(workerUrl(), { execArgv: ['--disable-warning=ExperimentalWarning'] });
w.unref(); // adapt 'message'/'error' events to WorkerLike.onmessage/onerror
```

- Dev runs `worker.ts` by native type stripping: its graph (`worker`, `read`, `symbols`, `../gpu`, `../needs`) gets
  `.ts` import extensions (already erasable; its one cross-package import is type-only). Prod:
  `new URL('./nvml-worker.js', import.meta.url)`; `vite.config.ts` gains the worker entry.
- `types: ["bun"]` and `@types/bun` leave `server`, `scripts`, `web`, `packages/webui-shared` (→ `node`, and
  `vite/client` for web). `site` keeps them until N10.

Gate: as N8, plus on this machine: NVML source active, PCIe throughput present; with the library path broken the
nvidia-smi fallback engages.
Docs: `developers/server/monitor.mdx`, `docs/system.mdx` if it names the binding,
`docs/getting-started/requirements.mdx` (experimental FFI note).
Risk: `node:ffi` may move within 26.x → pin CI to 26.13 and keep the fallback path tested.

### N10 — `site/` on Node (M). Independent after N4

- `site/scripts/{postbuild,check-links,serve,og,screenshots,demo-seed}.ts` → `node:http`, `fs.glob`,
  `zlib.gzipSync`, `readFile`/`writeFile`, `process.argv`, `import.meta.dirname`; run with `node scripts/x.ts`
  (erasable TS, `.ts` import extensions).
- `site/package.json` scripts and `catalog:` entries; `site/tsconfig.json` types → `node`, `vite/client`; tests on
  Vitest; `site-deploy.yml` on Node 26 + pnpm; `setup-bun` leaves all workflows.

Gate: full Node gate; `pnpm site:build`, `check-links`, `site:preview` serving a deep page; one `og` and one
`screenshots` run by hand (sharp, Chromium).
Docs: the site section of CLAUDE.md (commands, demo-instance command line).
Risk: `sharp`/`pagefind` under `allowBuilds`.

### N11 — Package and release (M). After N9

- The **root package is the packed one**: `bin: { "llama-webui": "dist/server/main.js" }`, `files: ["dist"]`,
  `os: ["linux"]`, `engines`; runtime externals in `dependencies` via `catalog:`; the two workspace packages in
  `devDependencies` (bundled; a `workspace:*` dependency would be rewritten to a version that cannot install).
  `private: true` stays unless `pnpm pack` refuses it (unverified).
- `scripts/smoke.ts --tarball`: `pnpm pack`, `npm install --prefix $tmp ./llama-webui-x.tgz`, then the N8 checks
  through `$tmp/node_modules/.bin/llama-webui`. A missing runtime dependency fails here.
- `release.yml`: version check (`scripts/release.ts --check`), build, pack, tarball smoke, `SHA256SUMS`,
  `gh release create`.

Gate: Node gate plus the tarball smoke in CI. Manual: `npm install -g ./llama-webui-<version>.tgz`, `llama-webui
--help`, real start.
Docs: `developers/architecture.mdx` (distribution paragraph), CLAUDE.md release paragraph.

### N12 — Docs sweep (M–L, parallelisable by page). After N11

README; `developers/{getting-started,index}.mdx`; `developers/contributing/{workflow,conventions,testing,how-to}.mdx`;
`docs/getting-started/{installation,requirements}.mdx` (install from the release tarball, Node 26 prerequisite,
systemd example); `docs/{configuration,faq,troubleshooting,index}.mdx`; `developers/llamacpp-js.mdx` (drop the "and
Bun" target); landing components under `site/src/landing/`; a final CLAUDE.md read-through. Then
`grep -rniE '\bbun\b|bun:|Bun\.'` over the repo with an allowlist (`docs/superpowers/plans/**` and the sentence
explaining the port). No screenshot retake: no UI changes.

Gate: Node gate, `site:build`, `check-links`.

### N13 — Cleanup and merge (S)

Remove the root `workspaces` field and any stray `BUN_PATH`; delete the stale untracked `shared/` directory (ask the
user first); rebase `node` on `master`; final PR. `site-deploy` publishes the new docs on merge. Hand the notes file
over as the backlog for the refactoring milestones (R…), to be planned with the user.

## Docs policy

- Reference pages of one module (`developers/server/*`, `developers/api/*`, `architecture`, `frontend`,
  `docs/security`) change in the milestone that changes that module, per the mapping table in CLAUDE.md.
- End-to-end pages (install, dev, test, contribute, release) can only be true once N8 and N11 exist: they are done in
  N12. The site deploys from `master` only, so nothing wrong is published meanwhile, and from `master`'s point of view
  code and docs land together.
- CLAUDE.md is updated in every milestone that changes one of its rules.
- `ci.yml` runs on every PR: each milestone edits it alongside the commands it changes (N1 install, N4 tests/check,
  N8 build/smoke, N10 drops `setup-bun`, N11 tarball).

## Quality gate summary

Zero errors and zero Biome warnings, on the runtime of the milestone:

- N1–N3: `bun run lint`, `bun run check`, `bun test`, llamacpp-js tests on Node, `bun run compile` + smoke-binary,
  site build + `check-links`.
- N4–N7: `pnpm lint`, `pnpm check` (`tsc -b`), `pnpm test` (Vitest + `node --test`), the few files still on
  `bun test`, compile + smoke, site. From N5 on, the contract golden must stay identical.
- N8–N13: `pnpm lint`, `pnpm check`, `pnpm test`, `pnpm build` + `node scripts/smoke.ts`, site build +
  `check-links`; from N11 on, the smoke on the tarball installed in an empty directory.
- N13: the final grep for Bun returns only the allowlist.
