# Nitro spike: report

Go/no-go record of the Nitro v3 spike (branch `spike/nitro`, never merged; plan:
`~/.claude/plans/on-va-faire-le-floofy-flurry.md`; probe: `app/probe/RESULTS.md`). The spike is a full vertical slice:
web and server in a single package `app/`, all 70 API routes as H3 file routes, `/ws` on crossws, the UI served by
Nitro, the llama-server lifecycle, the production build and the unchanged CLI. Measured on 2026-11-13 with
`nitro@3.0.261103-rc`, Vite 8.3.8 and Node 26.13.0, against `master` at the merge base.

| Commit    | Milestone                                                                   |
| --------- | --------------------------------------------------------------------------- |
| `16423da` | S0 probe of the six unknowns                                                |
| `066be7a` | S1 `app/` package skeleton                                                  |
| `6d00955` | S2 runtime and lifecycle                                                    |
| `7ea4180` | S3 H3 HTTP layer and the 70 routes                                          |
| `539ed5a` | S4 `/ws` on crossws                                                         |
| `1f36865` | S5 typed client on the generated route map                                  |
| `1961f91` | S6 production build, launcher and shutdown                                  |
| `830960d` | S7 contract suite against the production build                              |
| `89239f0` | S7 master's route and HTTP helper tests                                     |

**Verdict: conditional go.** Nitro clearly wins the dev loop and keeps behaviour parity, with no status change on the
498 contract cases. It brings nothing for typing: our own generator replaces `hc` at parity. Lifecycle reliability is
reached only through about ten lines of workaround that depend on srvx internals. Migrate once Nitro 3 leaves RC, under
the conditions in [Conclusion](#conclusion).

## Dev loop

| Measure (median of 5)                                     | master (`node --watch`) | Nitro (`vite dev`)    |
| --------------------------------------------------------- | ----------------------- | --------------------- |
| Save of a route file → `/api/health` answers the new code | 865 ms                  | **5 ms**              |
| Save of business code → `/api/health` answers it          | 867 ms                  | **63 ms**             |
| llama-server on a route save                              | stopped (restart)       | **kept** (same pid)   |
| llama-server on a business code save                      | stopped                 | stopped               |
| Open WebSockets on a route save                           | closed, reconnect       | **kept**              |
| Open WebSockets on a business code save                   | closed, reconnect       | closed 1001, reconnect |
| UI edits                                                  | Vite HMR                | Vite HMR (unchanged)  |

Method: `measure.mjs` rewrites the file with a marker and polls `/api/health` every 20 ms until the marker shows; the
round starts at the write. Route = `server/routes/api/health.get.ts` (master: `server/api.ts`); business code =
`server/lib/version.ts` (master: `server/version.ts`).

- **How.** Nitro's dev server re-evaluates only the changed file and its importers, in a worker thread of the Vite
  process. The runtime lives in a registry on `globalThis` (`server/lib/context.ts`, 100 lines). `boot()` and
  everything it imports are one module graph, so a save of business code re-evaluates `context.ts` with a new
  `OWNER`. The previous stack is then disposed, and a new runtime is built. A route save does not reach it.
- **Plumbing.** Host and dev plumbing goes from 512 lines (`dev.ts`, `host.ts`, `hostServer.ts`, `main.ts`, `rpc.ts`,
  `index.ts`, `routes/web.ts`, `ws/attach.ts`, root `vite.config.ts`) to 414 (`vite.config.ts`, `error.ts`, plugin,
  2 middlewares, `routes/ws.ts`, `boot.ts`, `context.ts`, `bin/llama-webui.ts`). Two packages, two `package.json` and
  two `tsconfig.json` become one package with two TS projects (DOM for `src/`, Node for `server/`).
- **HTTP layer.** 1,328 lines in 14 files (`api.ts`, `http.ts`, 12 domain routers) become 1,456 lines: 70 route files,
  `http.ts`, `apiTypes.ts` and 6 small `lib/` helpers for logic that several route files share. One file per route
  is easier to find and review, but the route table is no longer readable in one place: `server/api.gen.ts` is now
  that place.
- **Dev-only divergences.** Vite's `allowedHosts` answers a foreign `Host` with 403 `text/plain` before our guard,
  which answers 403 JSON in production. NVML sampler children of earlier boots show up as `<defunct>` zombies of the
  Vite process: their count stays flat across reloads, and they are never reaped while Vite runs.
- **Not re-measured in the app.** A Ctrl+C on `vite dev` with llama-server running: the permission classifier refused
  sending a signal to the dev server. The S0 probe applies. One SIGINT runs and awaits `close`. Two SIGINTs exit Vite
  at once, which orphans children; the supervisor's `setpriv --pdeathsig KILL` should cover llama-server, but this is
  unverified.

## Typing front/back

Nitro v3 has **no typed routes and no typed `$fetch`** (nitro.build docs). The spike generates them.
`scripts/gen-api.ts` (101 lines) scans `server/routes/api/` and writes `server/api.gen.ts` (218 lines): the
`ROUTES` manifest, which the 405 table also uses, and the `Api` type map. Each route's response type is read from its
handler's return type through `reply<T>()` (`JsonResponse<T>`, a type-only brand); body and query types come from the
route file's `export type Body` and `export type Query`. A Vite plugin regenerates the file at build start and on
every change under `routes/api/`, and `server/api.gen.test.ts` fails when it is stale. The client
(`src/lib/api.ts`, 122 lines vs 82) is `api('PATCH /api/settings', { params, query, body, signal })`; `request()`
gives the raw `Response` for the chat's SSE. 77 call sites were rewritten mechanically.

Three breaks were injected one at a time, and `tsc` was run on the web project:

| Break                                                     | `hc` (master)                                                     | Generated map                                                               |
| --------------------------------------------------------- | ----------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Response field renamed (`GET /api/downloads`, `items`)     | 1 error at the use                                                | 1 error at the use                                                          |
| Body field made required (`POST …/resume`, `force`)        | 1 error at the call                                               | 1 error at the call                                                         |
| Path renamed (`hf/status` → `hf/state`)                    | 1 error: `Property 'status' does not exist on type` + a type dump | 2 errors: `'"GET /api/hf/status"' is not assignable to 'keyof Api'` + its use |

Result: **parity**. The map names the missing route itself; `hc` buries it in a multi-kilobyte type. Route keys
(`'POST /api/sweeps/:id/resume'`) can be grepped across the client and the server. Costs:

- A generator and a Vite plugin to maintain, plus a convention: return `reply<T>()`, export `Body`/`Query`.
- A route that forgets `reply()` is typed `unknown`; `tsc` reports it at the first use.
- The body type is declared beside the zod schema instead of being inferred from the validator.

Nitro does not solve "sharing types between front and back"; merging the packages does that, and `hc` already did it
across two packages.

## Lifecycle reliability

Measured on the production build (`.output/llama-webui.mjs`), with the fake llama-server running, one WebSocket open
and a chat reply streaming (`FAKE_CHAT_DELAY_MS=2000`):

| Scenario                                         | master             | Nitro, first build                    | Nitro, after fixes                       |
| ------------------------------------------------ | ------------------ | ------------------------------------- | ---------------------------------------- |
| SIGINT, nothing open                             | exit 0             | 5.0 s, then exit code 1               | **1.0 s**, exit 0                        |
| SIGINT/SIGTERM, UI open + reply streaming        | WS 1001, "stopped" | 5.0 s grace, then sockets cut         | **1.0 s**, WS 1001, SSE ends cleanly     |
| Reply status after restart                       | stopped            | stopped                               | stopped                                  |
| Second SIGINT while llama-server takes 3 s       | ignored            | —                                     | ignored, exit after 3.0 s, code 0        |
| SIGTERM with `CI` or `TEST` set                  | exit 0             | **hangs forever** (found by S7)       | exit 0                                   |
| Orphans (llama-server, NVML sampler, perf)       | none               | none                                  | none                                     |

There were three defects, all fixed on the branch:

1. **Shutdown order.** srvx closes the HTTP server first, and Nitro runs the `close` hooks only after the last
   connection has ended (`setupCloseHooks`). An open UI or a streaming reply therefore held the server for the whole
   5 s grace delay, then got cut off. Fix: the runtime plugin registers its own SIGINT/SIGTERM handler before srvx's
   (plugins run before `serve()`), so the runtime is undone first, as `start()` did on master.
2. **No srvx handler under `CI`/`TEST`.** srvx skips graceful shutdown when either variable is set (GitHub Actions
   sets `CI=true`), so our handler swallowed the signal. Fix: the handler checks `process.listenerCount(signal)` and
   calls `process.exit(0)` itself when srvx is absent.
3. **A hidden 5 s timer.** `supervisor.stop()` races `proc.exited` against `sleep(5000)` without cancelling the
   sleep. On master, `process.exit(0)` hid it; Nitro lets the event loop drain. Fix: the five bounded waits use
   `{ ref: false }`. This one is a latent bug of master too.

The remaining second is srvx's countdown timer. The workaround relies on two srvx internals: listener order, and the
`CI`/`TEST` check. A change in either brings back a 5 s stop or a hang. Today the contract suite catches the hang (its
server runs under `TEST`), but nothing catches a slow stop. Production also logs srvx's `Stopping server gracefully
(5s)...` line on every stop.

## Behaviour parity

The contract suite (`app/server/lib/contract/contract.test.ts`) now runs the **production build** in its own process.
It seeds a temp data dir and sets two test settings that `boot()` reads: `LLAMA_WEBUI_TEST_MONITOR=stub` and
`LLAMA_WEBUI_TEST_OFFLINE=1`. It then replays the 498 cases in 1 s. Record: `golden.nitro.json`.

**498/498 cases, no status difference.** Remaining differences from master's `golden.json`:

| Case(s)                                        | master                                | Nitro                                                                 | Severity                        |
| ---------------------------------------------- | ------------------------------------- | --------------------------------------------------------------------- | ------------------------------- |
| `GET /api/health (Host a b)`                   | 400, no body (Node's parser answered) | 400 JSON `Invalid host` (our guard)                                   | none: more consistent           |
| `/`, `/chat/12`, foreign `Host` on a page      | `text/html;charset=utf-8`, stub body  | `text/html; charset=utf-8`, real `index.html` (the suite uses the build) | none                            |
| `POST /api/chat/1/messages (SSE)`              | `cache-control: no-cache`             | `private, no-cache, no-store, no-transform, must-revalidate, max-age=0` | none: stricter                  |

Found and fixed on the way:

- `index.html` was served without `cache-control`. A browser could heuristically cache it and keep old asset hashes
  after an upgrade. A `response` hook now sets `no-cache`, as `staticWeb` did.
- h3 logged every 4xx to stderr (`Profile not found`…). It is now `silent`; `errorResponse` logs the 500s.

Other notes:

- crossws has no `maxPayload`: the 4 KiB limit (close 1009) is checked after the frame is buffered. ws's default cap of
  100 MiB applies, after the same-origin check of the upgrade.
- 405 + `Allow` and the 404 `Unknown route` need our own `allowTable()` middleware: Nitro's SPA renderer answers every
  request no handler took (S0).
- Unit tests: 23 of master's 25 route and helper tests ported. `shadowed()` and `accepts()` are gone with Hono. Route
  files read a global `deps()`, so tests inject through `provideDeps()` and mount handlers with `routeApp()`; this is
  less direct than master's `createApi(deps)`. Full suite: 452 passed, 2 failed (`scripts/package.test.ts`, the npm
  package shape, see below).

## Outside the criteria

- **Stability.** Nitro is `3.0.261103-rc`. The defects above came from undocumented srvx and Nitro behaviour; the
  official docs disagree with each other on the shutdown delay (5 s vs 30 s; 5 s measured).
- **npm package.** `.output/` is self-contained: 6.4 MB, 1.6 MB gzipped, **no runtime dependency** (master needs
  `hono`, `@hono/node-server`, `ws`). It passes `scripts/smoke.ts`, also from a copy outside the repository. Not done
  yet:
  - `bin` → `.output/llama-webui.mjs`, `files` → `.output`;
  - `prepack.ts` and `smoke.ts --tarball`;
  - `package.test.ts`, which still expects the three dependencies;
  - `release.ts` already lists `app/package.json`.
- **Production output.** The output is chunked (`_chunks/`, `_routes/`, `_libs/`), not one file.
  `workerUrl()` resolves `nvml-worker.mjs` from the chunk `monitor.ts` lands in, which is `index.mjs` today; only the
  smoke test would catch a move.
- **Launcher.** It is built with Rolldown in the `compiled` hook, because Node does not strip types under
  `node_modules`. Nitro reads `NITRO_HOST`/`NITRO_PORT`, which the launcher sets from the parsed CLI options.
- **Not verified.** Whether Nitro reads `.env.local` in dev, and whether that would change our "only `.env`" rule.
- **Documentation.** CLAUDE.md would be rewritten:
  - APIs, Hono routes, typed client, Testing, Frontend, distribution;
  - the "Packages" and "Installation" sections lose `server/` and `web/`.

  The site needs about 12 pages updated:
  - `developers/architecture.mdx`, `frontend.mdx`, `getting-started.mdx`;
  - `api/overview.mdx`, `api/websocket.mdx`;
  - `server/security.mdx`, `server/supervisor.mdx`;
  - `contributing/conventions.mdx`, `contributing/testing.mdx`;
  - `docs/configuration.mdx`, `docs/security.mdx`, and the installation pages if the package changes.

## Conclusion

| Criterion          | Result                                                                                       |
| ------------------ | -------------------------------------------------------------------------------------------- |
| Dev loop           | **Clear win**: 5 ms / 63 ms vs ~865 ms, llama-server and sockets survive route edits       |
| Front/back typing  | **Parity**, at the cost of our own generator (Nitro provides none)                          |
| Lifecycle          | **Parity after three fixes**, one of them a workaround that depends on srvx internals          |
| Behaviour parity   | **Reached**: 498/498 statuses, three cosmetic header/body differences                        |

**Conditional go.** The day-to-day gain is real: editing an API route no longer restarts llama-server, so no model
reload and no lost chat. The tree is also simpler: one package, one Vite, no host server of our own. Nitro brings no
typing, though, and its shutdown has to be bent into the order we need. Conditions for the real migration:

1. **Nitro 3 stable**, not RC. Re-check the shutdown order (`setupCloseHooks`) and srvx's `CI`/`TEST` rule on that
   version. Keep a test that sends SIGTERM to the built server with a WebSocket and a stream open, and asserts a stop
   under 2 s.
2. **Ask upstream** for a pre-close hook, or a `gracefulShutdown` option in Nitro's config. This would remove the
   workaround.
3. **Keep the generator** (`gen-api.ts`) and its freshness test as the typing story, unless Nitro ships typed routes.
4. **Land the `{ ref: false }` fix on master now**: it is independent of Nitro.

If Nitro stays RC for long, the lower-risk alternative keeps Hono. It merges `server/` and `web/` into one package and
takes over two pieces of this spike that do not depend on Nitro:

- the `globalThis` runtime registry, which keeps llama-server alive across route edits under a Vite module runner;
- the generated route map, if `hc`'s error messages are worth replacing.

**Estimate of the real migration** from this branch, about 4 to 6 days:

- **Packaging:** `package.json`, `prepack`, `package.test.ts`, `smoke --tarball`, CI and release workflows.
- **Docs:** CLAUDE.md and ~12 site pages.
- **Cleanup:** remove `app/probe/`.
- **Tests:** a dev-loop test replacing `dev.test.ts`, and the SIGTERM test of condition 1.
- **Re-verification** on the stable Nitro release.
