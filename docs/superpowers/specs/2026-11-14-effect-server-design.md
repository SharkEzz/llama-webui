# Effect server rewrite (POC): design

Branch `poc/effect`. Decisions marked **(user)** were taken by the user on 2026-11-14; those marked **(call)** are the
author's and can be overturned.

## Intent

Rewrite the whole server of llama-webui (`app/server/`, about 13,000 lines and 6,500 lines of tests, on Nitro v3) on
Effect 4, in place, and remove Nitro and everything Effect can replace. It is a proof of concept: the branch exists to
**judge** whether Effect is the right foundation, on the complete server and not on a slice, and it ends with a measured
report that decides whether it is merged.

Why Effect **(user)**, all four:

1. **Lifecycle and resources.** Startup, shutdown, llama-server, sockets and downloads owned by `Layer`/`Scope`, in
   place of the `AsyncDisposableStack` of `boot.ts`, the `globalThis` registry of `context.ts` and the signal handling
   of `plugins/runtime.ts`.
2. **Typed errors and concurrency.** Errors in the types; interruption, timeouts, retries and streams (chat, bench,
   downloads) expressed with Effect rather than by hand.
3. **Leaving Nitro.** No release candidate, no workaround for its shutdown, its dev worker or its route scan.
4. **One coherent stack.** HTTP, SQL, CLI, configuration, processes and tests from Effect, in place of the home-made
   `http.ts`, `proc.ts`, `sqlite.ts`, `env.ts`, `cli.ts`, `llamaFetch.ts` and of zod.

## Goals

- `app/server/` is idiomatic Effect (the style of `repos/effect/LLMS.md`): services, layers, tagged errors, `Schema`,
  scoped resources. No Nitro, h3, srvx, crossws or zod left in the repository.
- **Functional parity of the UI (user):** every screen does what it does today, on an existing data directory (the
  current SQLite file opens and keeps its rows).
- The HTTP API is redesigned freely around `HttpApi` **(user)**; the web calls it through a client derived from that
  definition **(user)**.
- A **measured report** comparing before and after **(user)**, the basis of the merge decision.

## Non-goals

- New features, a new database schema, or changed behaviour of a screen.
- Effect in the React components or in the web's state: the web gets the derived client, wrapped in Promises, and
  nothing else **(user)**.
- Telemetry export (OTLP), API documentation pages (Scalar, Swagger).
- Any change to `packages/llamacpp-js`: it stays as it is, dependency-free and Promise-based, with its client for its
  other users. The server stops using its I/O (see "Outside world").
- The public site beyond the documentation pages that describe the server.

## Anti-goals

The rewrite fails, even if it runs, when:

- old Promise code is wrapped in `Effect.promise` and called migrated;
- a behaviour disappears silently (a test dropped without a line in the report);
- an existing data directory loses data or no longer opens;
- the published package gains a runtime dependency, or `llamacpp-js` gains any;
- the report hides a cost (bundle size, unstable APIs, lines of code).

## Constraints

- Effect 4.1.4, pinned in the catalog and equal to the vendored `repos/effect`; nearly everything beyond the core is
  tagged `@stability unstable` (accepted, `unstableApiUsage` is off).
- Node ≥ 26.13 only, pnpm, one process in production on port 7860, Linux.
- The published root package stays autonomous: `app/.output/` only, no dependency, server bundle importing nothing but
  `node:*`. `.output`'s layout (`llama-webui.mjs`, `server/index.mjs`, `server/nvml-worker.mjs`, `public/`,
  `THIRD-PARTY-LICENSES.md`) is kept so packaging and release scripts do not change **(call)**.
- The launcher's flags do not change: `--help`, `--host`, `--port`, `--data-dir`, `--env-override`; nor the
  `LLAMA_WEBUI_*` variables and the `.env` rules (the environment wins unless overridden) **(call)**.
- SQLite through `node:sqlite` (`@effect/sql-sqlite-node`); NVML stays a forked child process using `node:ffi`.
- Project rules of `CLAUDE.md` still apply: English, Biome clean, `pnpm lint`, `pnpm check` and `pnpm test` green at the
  end of every milestone, documentation of `site/content/` in sync by the end of the branch.

## Approaches

Three were considered.

1. **Foundation first, then domain by domain (chosen, user).** The first milestone removes Nitro and builds everything
   uncertain on a tiny domain: HTTP server, WebSocket, SSE, static UI, clean shutdown, autonomous build, dev loop,
   derived client in the web bundle. Then each domain comes back whole, from schema to web calls, with its tests.
   Risks are met first and no bridging code is written to be thrown away. Cost: the app is incomplete during the
   migration, screens come back one by one.
2. **Strangler.** Effect routes mounted inside Nitro (`HttpRouter.toWebHandler` behind a catch-all route), Nitro
   removed last. The app works at every step, but the bridge is throwaway, the lifecycle stays Nitro's until the end,
   and the build and dev loop (the most uncertain parts) are discovered last.
3. **By technical layer, inside out.** Processes, SQLite, HTTP client and config first, then domains, then HTTP and the
   API in one jump. The app runs on Nitro for a long time, but the last jump stacks the API, the web, the build and the
   dev loop, and services are shaped before the API that consumes them.

Approach 1 was chosen because the user accepts an app that does not run while the foundation is built, and it is the
only one that tests at the start what can make the POC fail.

## Transition (user)

Nitro leaves at E1, but a domain is rewritten only at its own milestone. In between:

- At E1 the whole Nitro server (`lib/`, `routes/`, `middleware/`, `plugins/`, `error.ts`, `api.gen.ts`, their
  tests, the contract golden) moves to `app/server-legacy/`: a read-only reference, outside lint, type check and
  tests, as `repos/` is. Nitro, h3 and `app/build/apiTypes.ts` are removed then; nothing in the legacy folder is
  expected to compile.
- A domain's legacy files are deleted at the end of the milestone that rewrites it. E9 checks the folder is gone.
- No bridge: old and new code never call each other, and no dependency is kept for the legacy folder's sake. zod
  leaves `@llama-webui/shared` schema by schema as each domain moves to `Schema`, and the catalog at the latest in
  E9.
- The web builds and type-checks at every milestone. A screen whose domain is not ported yet shows a short "not
  ported yet" message in place of its page; how its sources are kept out of the build until then is the builder's.
- **"Green" during the migration** means `pnpm lint`, `pnpm check` and `pnpm test` pass on what is in the tree
  outside `app/server-legacy/`. The test suite therefore shrinks at E1 and grows back until E8; tests are accounted
  for against the E0 inventory, not against the files present.

## What the user decided about the how

- **In place** in `app/server/`: files are replaced, the Nitro server does not stay runnable.
- **Shared schemas:** `@llama-webui/shared` moves from zod to `Schema`, and holds the `HttpApi` definition.
- **Web client:** derived from the `HttpApi` definition, wrapped so components keep calling Promises.
- **Dev loop:** `pnpm dev` runs Vite (HMR of the UI) and the Effect server under `node --watch`; Vite proxies `/api`
  and `/ws`. Any server save restarts it and therefore stops llama-server: accepted, no reload code to maintain.
- **Rhythm:** small milestones run autonomously; the consequential ones are validated by the user.

## Architecture (calls, unless marked)

### Packages

- `packages/webui-shared`: domain schemas (`Schema`), the tagged errors that cross the wire, the WebSocket message
  union, the chat stream events, and the `HttpApi` definition (one `HttpApiGroup` per domain). Pure logic already
  there (`format`, tuning maths…) stays plain TypeScript. Effect's guide asks for API definitions apart from the
  server so the client never pulls server code: this package is that place.
- `app/server`: the implementation. One folder per domain holding its services, its `HttpApiBuilder.group` handlers
  and its tests; the `lib/` + `routes/` + `middleware/` + `plugins/` split disappears.
- `app/src`: the web. It imports `@llama-webui/shared` at runtime and no longer imports types from `server/`, so the
  client project stops type-checking server sources.

### Process and lifecycle

- One entry point: the application `Layer`, run by `Layer.launch` under `NodeRuntime.runMain`. Signals interrupt the
  main fiber; finalizers run in reverse order of construction. No `globalThis` registry, no ready middleware, no
  signal handler of our own.
- Every long-lived thing is a scoped resource of a service layer: the database, the supervisor's llama-server
  process, the monitor and its collectors, the NVML child, the WebSocket hub, chat runs, the bench runner, the
  download queue, the external-server watch.
- The behaviours of today's shutdown are requirements, verified by the lifecycle tests:
  - a streaming reply is saved "stopped", a running sweep "interrupted", a download keeps its `.part`, all while
    llama-server still runs; then sockets close with 1001, then llama-server stops, then the database closes;
  - shutdown with the UI open and a reply streaming takes under 2 s; a second signal forces the exit;
  - llama-server is killed as a last resort when the process exits without its finalizers;
  - a taken port exits with code 1 and a message naming it, **before** the data directory is touched; a failed
    startup exits with code 1.
- Startup work stays: orphan replies and runs are marked, the interrupted download resumes, an external llama-server
  is detected then watched.

### HTTP

- `NodeHttpServer` serves one router: the `HttpApi` (JSON endpoints, validated by `Schema` on both sides), plain
  routes for what `HttpApi` does not model well (the chat's event stream, file downloads such as profile export),
  `/ws`, and the UI.
- The UI: hashed assets with `immutable` caching, `index.html` with `no-cache` for any other path, 404 for a missing
  asset.
- The security guard of `lib/security.ts` (trusted Host, same Origin, JSON-only writes) becomes a middleware in front
  of the API, with the same rules.
- Errors are `Schema.TaggedError` classes declared on their endpoints with their status. The web tells them apart by
  tag (today: `code`), never by message text.
- Paths and resource names are kept where there is no reason to change them; the redesign serves `HttpApi` and typed
  errors, not novelty.

### WebSocket and streams

- `/ws` stays one push channel. The message union of `packages/webui-shared/src/ws.ts` becomes a `Schema` union;
  the hub is a service that publishes (`PubSub`), each connection a fiber that subscribes, with the hello, ping/pong
  and 1001-on-shutdown of today.
- The chat reply stream stays Server-Sent Events over HTTP, built from a `Stream`, with its keep-alive comment.

### Data

- `SqliteClient` (`@effect/sql-sqlite-node`) and repositories as services; rows decoded by `Schema`.
- Migrations: the existing ones are ported one for one, same SQL, including the table rebuilds that need foreign keys
  off. A database created by the current app (table `schema_version`) must be recognised and continue from its
  version without replaying anything. How the Effect `Migrator` is seeded from `schema_version` is the builder's.

### Outside world

- llama-server, llama-bench, `nvidia-smi` and the other commands run through `effect/process`.
- Requests to llama-server and to Hugging Face go through an Effect `HttpClient` backed by `node:http`/`node:https`.
  Two properties of today's `llamaFetch`/`downloadFetch` must hold and stay tested: no abort after 300 s of silence,
  and HTTP/1.1 for model downloads (HTTP/2 caps a stream near 22 MiB/s). Proxy variables are honoured as today.
- `llamacpp-js` **(user)**: the server keeps only its pure modules (SSE parsing, metrics, flags, llama-bench output,
  error classes). The I/O it does today through `llamacpp-js/client` (chat completion stream, health and server
  probes, props, on an injected `fetch`) and `llamacpp-js/node` (`--help` of a binary, the `/proc` scan) is
  rewritten in the server on `HttpClient`, `Stream`, `effect/process` and `FileSystem`. That logic then exists
  twice, in the package and in the server: accepted, and counted in the report. `Llama*Error` raised by the pure
  modules become tagged errors.
- Configuration through `Config`; the CLI through `effect/cli`; time through `Clock`/`DateTime`.

### Web client

- `app/src/lib/api.ts` becomes a thin layer over `HttpApiClient.make(Api)` with the fetch client: each call returns a
  Promise, failures reject with the tagged error. The 92 call sites move domain by domain with their server side.
- `api.gen.ts` and `app/build/apiTypes.ts` are deleted.
- The client-side rules of `build.test.ts` stay (split per page, three.js only in Topology's chunks, no `node:*`).
  The growth of the web bundle is measured and reported.

### Build, dev, tests

- Build: Vite builds the client only; Rolldown builds the server, the NVML worker and the launcher into `.output/`,
  and the third-party licenses file is still written from what was bundled.
- Dev: one `pnpm dev` starts Vite and the watched server. The server listens on an internal port that Vite proxies
  to (not 7861, used by the demo instance). Running the server from source means Node's type stripping: relative
  imports with `.ts` extensions and erasable syntax only. If that proves impractical, a Rolldown watch build is the
  fallback; the choice is made in the foundation milestone.
- Tests: Vitest stays, with `@effect/vitest` for Effect code (test layers instead of hand-wired doubles,
  `TestClock` for time). The existing tests are the specification of parity: each one is ported, or its removal is
  justified in the report.
- The contract suite keeps its principle: every endpoint replayed over real HTTP against the production build and
  compared to a golden file. The golden is regenerated per domain as the API is redesigned, reviewed, then frozen.
  The endpoint list comes from the `HttpApi` definition.
- `lifecycle.test.ts`, `build.test.ts` and `dev.test.ts` are rewritten for the new server; packaging and smoke
  scripts keep working.

## Milestones

`E0` to `E10`. Each ends green and committed. **Validated by the user:** `E1` and `E10`; the others run
autonomously, stopping only when a decision is the user's.

| #   | Milestone           | Content                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| --- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| E0  | Baseline            | Numbers of the Nitro server for the report (see below), taken on `6327201a3`; inventory of every test (file, name, domain) and of the behaviours to port, committed: it is what the report counts against.                                                                                                                                                                                                                                                         |
| E1  | **Foundation**      | Nitro removed, the old server moved to `app/server-legacy/`, unported screens replaced by their waiting message. Entry point, config, CLI and launcher, HTTP server, guard, static UI, `/ws` with hello and ping, an SSE proof, SQLite with the migration bridge, the `HttpApi` skeleton in shared with health/state and settings, derived web client, Rolldown build, dev loop, lifecycle tests (signals, taken port). The app shows its shell and Settings only. |
| E2  | Profiles            | CRUD, duplicate, import/export, llama-tui import, flags.                                                                                                                                                                                                                                                                                                                                                                                                           |
| E3  | Supervisor          | llama-server process, logs, server state and commands, launchpad, external watch, props; `server-state` and `log` messages.                                                                                                                                                                                                                                                                                                                                        |
| E4  | Monitoring          | Collectors, NVML child, snapshot and history, system info, topology and placement; `snapshot` and `placement` messages.                                                                                                                                                                                                                                                                                                                                            |
| E5  | Chat                | Conversations, runs, the event stream, stop and regenerate.                                                                                                                                                                                                                                                                                                                                                                                                        |
| E6  | Models              | Model list and info, GGUF cache, Hugging Face search and repo, download queue; download messages.                                                                                                                                                                                                                                                                                                                                                                  |
| E7  | Bench and sweeps    | Runner, gate, executor, sweeps, resume; bench and sweep messages.                                                                                                                                                                                                                                                                                                                                                                                                  |
| E8  | Tuning and setup    | Checks, estimate, plan, disk speed, hardware; first-run setup.                                                                                                                                                                                                                                                                                                                                                                                                     |
| E9  | Hardening           | Full contract golden frozen, lifecycle/build/dev/packaging suites complete, `app/server-legacy/` empty and removed, zod gone, Effect warnings at zero and `ignoreEffectWarningsInTscExitCode` removed, the three rules lowered for the POC settled, CI.                                                                                                                                                                                                            |
| E10 | **Docs and report** | `CLAUDE.md` and the developer pages of `site/content/` rewritten for the new server; the measured report.                                                                                                                                                                                                                                                                                                                                                          |

From E2 on, a domain's milestone covers its schemas, services, API group, WebSocket messages, web call sites and
tests, brings its screens back, and deletes its legacy files. `CLAUDE.md` is kept accurate at each milestone for the rules a contributor needs.

## The report (E10)

Before (E0) and after, same machine:

- lines of code and files: server, server tests, shared, web client layer;
- direct dependencies, and packages bundled into the server;
- size of `.output`, of the server bundle, and of the web bundle (raw and gzip);
- time from launch to `/api/health`, and shutdown time with a page open;
- duration of `pnpm test` and `pnpm check`;
- tests ported, rewritten and dropped against the E0 inventory, each drop with its reason;
- logic that now exists twice (the I/O of `llamacpp-js` redone in the server), in lines;
- workarounds for upstream issues, before and after;
- what Effect made simpler and what it made harder, with examples from the code; the cost of unstable APIs met
  during the work.

Parity is checked by the ported tests, the contract suite, a pass on an existing data directory, and by the user on
the running app. The site's screenshot pipeline (`pnpm --dir site screenshots` on the demo instance) can compare
screens before and after; it needs the GPUs, so it runs only if the user frees them.

## Left to the builder

- File and module names inside `app/server/` and `packages/webui-shared/`, within the conventions of
  `repos/effect/LLMS.md` and the service keys the language service expects.
- The shape of each redesigned endpoint and of each tagged error.
- How repositories are written (`sql` templates, `SqlSchema`, `Model.Class`) and how the migrator is bridged.
- How the dev command starts its two processes, and the internal port.
- The order of work inside a milestone.
