# Effect POC, E6: Models Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring the models and the Hugging Face downloads back under the Effect server: the scan of the models folder
with its `model_cache` table, a GGUF's detail, usage and deletion; the Hub's search, repository and account through an
HTTP client of its own (proxy of the environment, HTTP/1.1, no silence limit); the download queue (one item at a time,
`.part` files resumed, checked against their sha256, retried, cancelled, resumed after a restart) and its three
WebSocket messages; on the web the Models page, the downloads sheet, the model picker and "create from model".

**Architecture:** The shared package moves `models.ts` and `hf.ts` from zod to Schema and gets three API groups
(`models`, `hf`, `downloads`) and the three `download*` messages of `WsMessage`. The server gets three folders:
`models/` (the GGUF reader with its cache of 8, the sizes, the scan, `ModelCacheRepo`, usage and deletion), `hf/` (the
token and endpoint, the paths, the variants, `HfHttp`, `HfClient`, the repository description) and `downloads/`
(`DownloadsRepo`, one file's transfer, and `Downloads`, the queue: one fiber in the layer's scope, its starts
serialised under a semaphore, its messages through `WsHub.publish`, a shutdown step that keeps the `.part`).

**Tech Stack:** Effect 4.1.4 (`effect`, `effect/http`, `effect/http-api`, `effect/sql`, `Cache`, `Semaphore`,
`FileSystem`, `Stream`, `TestClock`), `@effect/platform-node` (`NodeHttpClient`, `NodeFileSystem`),
`@huggingface/gguf` 0.4.6 (already a dependency of `app/`), Vitest 5, `@effect/vitest`, Biome, Playwright (the look).

**Spec:** `docs/superpowers/specs/2026-11-14-effect-server-design.md` (E6 row; "Outside world": every outside call has
its own client). Acceptance list: `docs/superpowers/poc-effect/behaviours.md`, section E6 (and its `From E2:` and
`From E3:` lines, and the lines of E1 and E3 that moved the proxy to E6). Rules: `docs/superpowers/poc-effect/conventions.md`.
Defects to decide: `docs/superpowers/poc-effect/defects.md`, "E6: models and downloads".

**Calls made by this plan** (the author's; each is recorded by Task 10):

- **The GGUF is read by `@huggingface/gguf`** (`gguf`, `ggufAllShards`, `allowLocalFile: true`,
  `computeParametersCount: true`) inside `Effect.tryPromise`, its failure `ModelReadError { message }` with the Nitro
  messages word for word: `file not found: <path>` (`ENOENT`, `ENOTDIR`), `permission denied: <path>` (`EACCES`,
  `EPERM`), `<code>: <path>` (any other errno), `unreadable GGUF: <message>`. `stat`, `readDirectoryEntries`,
  `realPath`, `remove` and `rename` go through `FileSystem`; the errno comes from the `cause` of its `SystemError`
  (Facts). The parse itself (`parseModel`, `weightSizes`, `tensorBytes`) stays pure.
- **The 8 parsed GGUFs are a `Cache.makeWith`** of capacity 8 keyed by path, holding `{ stamp, model }`; a get whose
  stamp (every part's `mtime` in ms and size) differs invalidates the entry and reads again; a failed read is not kept
  (`timeToLive` zero on a failure, as `flags/Flags.ts`). Effect's `Cache` is LRU (a hit refreshes the entry): the Nitro
  map dropped the oldest read. Recorded as changed; the test `the cache keeps the last 8 models only` holds either way.
- **A stamp is `<mtime ms>:<size>` per part**, from `FileSystem`'s `mtime` (a `Date`, whole milliseconds): the Nitro
  server wrote `mtimeMs` with its fraction, so each `model_cache` row it wrote misses once and is read and rewritten at
  the first scan. Recorded as changed.
- **Hugging Face has its own HTTP service, `HfHttp`** (`hf/HfHttp.ts`): `NodeHttpClient.layerNodeHttpOptions({
  keepAlive: true, proxyEnv })` under its own tag, each request in its caller's scope (`HttpClient.withScope`, as
  `LlamaHttp`). It is `node:http`/`node:https` (HTTP/1.1, the HTTP/2 window of Hugging Face capped a stream at ~22
  MiB/s), it has no time limit of its own (each caller bounds its wait: 10 s for an API call, 60 s of silence for a
  transfer) and it never follows a redirect (the queue follows up to 6 by hand and sends the token only to the
  endpoint's origin).
- **The proxy is the agents', not a global one (departs from the caller's decision 4):** `proxyEnv` is read through
  `Config` (`HTTP_PROXY`, `HTTPS_PROXY`, `http_proxy`, `https_proxy`, `NO_PROXY`, `no_proxy`, with `localhost`,
  `127.0.0.1` and `::1` always added to the no-proxy list) and handed to the two agents of `HfHttp`, which Node 26
  honours (`http.Agent({ proxyEnv })`, Facts). `useEnvProxy`'s `setGlobalProxyFromEnv` is not ported: nothing else of
  the Effect server uses `fetch` or Node's global agents (Facts; `LlamaHttp` has its own direct agent), the global
  mutation would need a `node:http` import and its undo, and "built first, undone last" becomes "the agents are made
  and destroyed with `HfHttp`'s layer" (`makeAgent` in its scope). The two Nitro `useEnvProxy` tests are rewritten as
  `HfHttp` tests (proxy honoured, loopback and `NO_PROXY` direct).
- **`LLAMA_WEBUI_TEST_OFFLINE=1`** (exact value, read by `HfHttp.layer` through `Config`, as `Monitor.layer` reads
  `LLAMA_WEBUI_TEST_MONITOR`) gives a client whose every request fails with
  `HttpClientError(TransportError({ request, description: 'fetch failed' }))`: every Hub route answers 502
  `Hugging Face unreachable: fetch failed` (code `hf-unreachable`) as today. The contract suite's `launch()` sets it.
- **The Hub's unreachable message is `Hugging Face unreachable: <reason>`** with the `TransportError`'s description,
  else its cause's message (`getaddrinfo ENOTFOUND huggingface.co`, `connect ECONNREFUSED …`): Node's `fetch` said
  `fetch failed` for all of them. A Hub API call that does not answer in 10 s reads `Hugging Face unreachable: no
  answer in 10 s` (was `The operation was aborted due to timeout`). Both recorded as changed.
- **The download queue is a scoped service, `Downloads`**: one fiber forked in the layer's scope runs the loop; its
  state (the running item, its live progress, a `dirty` flag, `closing`) in one `SynchronizedRef`; `enqueue` and
  `retry` serialised by `Semaphore.make(1)` (`withPermits(1)`), the rows they create written in one uninterruptible
  step (a client that leaves mid-request leaves no half-written queue); time from the `Clock`.
- **The retries are a loop over the pauses `[2, 4, 8, 16, 30]` s with `Effect.sleep`, not a `Schedule` (departs from
  the caller's decision 5):** the budget is reset after an attempt that received data, which a `Schedule`'s state
  cannot see without the attempt's outcome being threaded into it. The pauses run on the `Clock` (the `TestClock` in
  the tests), each published as `retrying` with its `retryAt` before it starts. Once spent, the item fails with 502
  and the last message (code `hf-unreachable`).
- **The stall is `Stream.timeoutOrElse({ duration: '60 seconds', orElse: … })`** on the body (checked between two
  chunks, Facts) plus a 60 s `Effect.timeoutOrElse` on the wait for the headers; both fail the attempt as retryable
  `no data for 60 s`.
- **A shutdown step (`shutdown.before`)** sets `closing` and interrupts the running transfer: its `.part` is kept, its
  row stays `downloading`, nothing is written or published by the queue afterwards; the next start resumes it. The
  layer resumes at its build (the item left `downloading` first, then the queued ones by id). Download rows are never
  orphans: the order against `ChatRuns`' orphan marking does not matter, and the layer sits in the same tier.
- **The queue publishes through `WsHub.publish`**: `download` (`DownloadItem`), `download-progress` (`DownloadLive |
  null`) and `download-deleted` (`{ ids }`), new members of `WsMessage`. The log lines stay word for word
  (`[llama-webui] download <repo>/<file>: <message>, retrying`, `[llama-webui] download <repo>/<key> failed:
  <message>`, `[llama-webui] download queue stopped: <cause>`), through `Effect.logWarning`/`logError`.
- **The sha256 is `createHash('sha256')` of `node:crypto`, the free space `statfs` of `node:fs/promises`: two new
  `nodeBuiltinImport:off` directives (departs from conventions' "one today"),** each in a module of its own
  (`downloads/hash.ts`, `downloads/freeSpace.ts`) with its reason on the line: Effect's `Digest` is one-shot over a
  `Uint8Array` (a GiB file cannot be held), and `FileSystem` has no `statfs` (Facts). `conventions.md` is updated at
  Task 10.
- **Errors are tagged** (in `@llama-webui/shared`, messages word for word, `httpApiStatus` as today): `ModelNotFound`
  404 `Model not found`, `ModelFileNotFound` 404 `File not found`, `ModelUnreadable` 422 (the read error's message),
  `ModelInUse` 409 (`The running server uses it (profile “<name>”): stop it first` or `A download in progress writes
  it`), `HfGated` 403, `HfNotFound` 404 (also `No GGUF “<key>” in <repo>`), `HfUnauthorized` 401, `HfRateLimited`
  429, `HfUnreachable` 502 (`Hugging Face error <status>[: <x-error-message>]`, `Hugging Face unreachable: …`,
  `Hugging Face sent an invalid response (<path>)`, `Too many redirects from Hugging Face`), `HfInvalidPath` 400
  `Invalid file path in the repository: <path>`, `ListedTwice` 400 `<name> is listed twice`, `AlreadyQueued` 409
  `<name> is already in the download queue`, `DiskFull` 507 `Not enough disk space: <need> to download (plus 1.0 GiB
  margin), <free> free`, `DownloadNotFound` 404 `Download not found`, `NotFinished` 409 `Only a failed or canceled
  download can be retried`. The web tells them by `_tag` (`RepoView`'s `hf-gated`/`hf-not-found` become `HfGated`/
  `HfNotFound`). The `code` stored in a `DownloadItem` stays the Nitro string (`hf-gated`, `checksum-mismatch`,
  `disk-full`, `download-failed`, `hf-unreachable`…): it is data, read by `QueueList`.
- **The query refusals become `RequestInvalid` 400 `Invalid data: <message> (<key>)`**, as E2 to E5 set for bodies:
  `GET /api/hf/search` `q` (trimmed, 1 to 200 characters, `Search text expected (200 characters at most)`),
  `GET /api/models/usage` `path` (`path required`), `GET /api/hf/repo` `id` (`Invalid repository id: <id>`, a
  `makeFilter`), `GET /api/models/info` `path` (`Absolute path to a .gguf file expected`). Recorded as changed (was a
  400 with the bare message).
- **An id of `/api/downloads/:id` that is not a positive integer is the unknown route** (`IdParam`, as E2): 404
  `RouteNotFound` `Unknown route` (was `Download not found`).
- **`DELETE /api/downloads/:id` decides cancel-or-remove in one step under the queue's lock**: the two 409s that only a
  race could reach (`This download is not running`, `Cancel this download first`) are not ported (defects.md E6,
  `confirmed`, fixed by construction). A queued item whose files cannot be deleted is still marked and published
  `canceled`, and the request answers 500 (a defect of the `FileSystem`, `Effect.orDie`), as today.
- **`GET /api/models/info` stays unconfined** (caller's decision 7, decided the way E5 did): `design choice`. The site
  documents it as by design ("no allowlist of folders", `site/content/developers/server/security.mdx:159-166`), the
  Tuning page (E8) reads the detail of a profile's model, which may be anywhere, and the API is behind the guard
  (loopback or the configured origin). Ported as it is, with a test that a file outside the folder answers its detail
  with an absolute `relPath`.
- **"A benchmark in progress uses it" is removed until E7** (caller's decision 6): `blocked` and the delete's check read
  the managed server (`activeProfileId` and `profilePaths`) and the queue's active items only; a `From E6:` line in the
  E7 section of `behaviours.md` brings the benchmark and sweep check back with the bench.
- **The model's files are deleted before its profiles** (defects.md E6: `design choice`): a file that cannot be removed
  answers 500 and keeps every profile; the other order could leave profiles deleted for a model still on disk.
- **`lib/llamaFetch.ts` is kept whole (departs from the caller's decision 8):** `downloadFetch` and `llamaFetch` share
  `nodeFetch` (`app/server-legacy/lib/llamaFetch.ts:76`, `:84`) and legacy files are never edited, only deleted; the E7
  bench reads `llamaFetch`. Its four `downloadFetch` tests are rewritten as `HfHttp` tests; the file goes with E7.
- **The disk space check** reads `statfs` of the destination folder or its nearest existing parent, adds the active
  items' remaining bytes and a 1 GiB margin; `Downloads.layerWith({ freeBytes?, marginBytes?, … })` lets a test give
  its own, as the Nitro `deps` did.

## Global Constraints

- Branch `poc/effect`, after E5 (`chore(poc): Measure E5` and its review fixes). Commit on it; the controller pushes.
- **Before writing any Effect code, read `repos/effect/LLMS.md` completely**, then
  `docs/superpowers/poc-effect/conventions.md`, then the reference files of the task. `repos/effect` is the installed
  version (4.1.4): read it, not `node_modules`, and never edit it. `NodeHttpClient` is in
  `repos/effect/packages/platform/node/src/NodeHttpClient.ts` (not `platform-node/`), `NodeFileSystem` in
  `repos/effect/packages/platform/node-shared/src/NodeFileSystem.ts`.
- **Effect diagnostics are blocking:** `pnpm check 2>&1 | grep -c 'effect('` prints `0`, warnings included. The only
  changes of `tsconfig.effect.json`: `packages/webui-shared/src/models.ts` and `packages/webui-shared/src/hf.ts` join
  the third override (Task 1). The only new `@effect-diagnostics` directives: `nodeBuiltinImport:off` in
  `app/server/downloads/hash.ts` (`node:crypto`) and `app/server/downloads/freeSpace.ts` (`node:fs/promises`), each
  with its reason on the line. Any rule that seems wrong for a piece of code: stop and report, do not lower it.
- Idiomatic Effect only (conventions): services are `Context.Service` classes keyed
  `@llama-webui/app/server/<path>/<Name>` with their layers as statics, methods `Effect.fn('Service.method')`, errors
  `Schema.TaggedError<X, { readonly X: unique symbol }>()` built with `X.make(…)`, time from `Clock`, SQL through
  `SqlClient`, files through `FileSystem`, configuration through `Config`. Promise code wrapped in `Effect.promise`
  does not count as ported (`@huggingface/gguf` is the one `Effect.tryPromise`, with its typed failure).
- **No Hub request uses Node's `fetch`, `downloadFetch` or a global agent:** every one goes through `HfHttp`.
- `app/server-legacy/` is a read-only reference: port behaviour, not structure; never import it. Only Task 10 deletes
  files in it (`lib/llamaFetch.ts` and its test stay for E7; `lib/models/{gguf,scan,sizes,gguf.fixture}.ts`,
  `lib/db/modelCache.ts`, `lib/proc.ts` and `lib/env.ts` stay for E7 and E8).
- A reply carries what is stored: its schema has no input rule (conventions, "Replies"): `DownloadItem.code` is any
  string, `ModelSummary` decodes what a Nitro-written `model_cache` row holds.
- Server and shared code runs under Node as it is: relative imports end in `.ts`, erasable syntax only.
- No dependency is added; zod stays in the catalog (other modules still use it) but leaves `models.ts` and `hf.ts`.
- **Never start anything on port 7860 or 7861**, nor on the default data folder, nor on the user's models folder or
  Hugging Face cache. Tests never use port 8080, never reach `huggingface.co` (a fake Hub on loopback through
  `HF_ENDPOINT`, or `LLAMA_WEBUI_TEST_OFFLINE=1`), and set `HOME`, `HF_TOKEN`, `HF_TOKEN_PATH` and `HF_ENDPOINT`
  themselves (through a `ConfigProvider` or the launched process's environment): the user's token never shows.
- Tests on real time (sockets, the fake Hub): `layer(L, { excludeTestServices: true })`; the pauses, the stall and the
  progress throttle are tested on the `TestClock` (`TestClock.adjust`). A test that starts a process asserts it is
  dead at the end.
- The sandbox runs as root: a test that needs a file the user cannot read skips under root, as the Nitro test did
  (`process.getuid?.() === 0`).
- Code, comments, test names, messages and commits in English. Commits end with
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` and
  `Claude-Session: https://claude.ai/code/session_01K4yABodmjP6snLXjiiu2nS`.
- `pnpm lint`, `pnpm check` and `pnpm test` green at the end of every task, except the two known `dev.test.ts` timing
  tests of this container (`in dev, without Effect DevTools, a restart does not wait for them`, and `one SIGINT stops
  vite dev and the server`, which fails only after it); `pnpm test` stops before `llamacpp-js` when Vitest fails, so
  `pnpm --filter llamacpp-js test` is run on its own. Zero Biome warning. Format a Markdown or JSON file you wrote with
  `pnpm exec biome check --write <file>`.
- **Gates of every task:** `pnpm lint`, `pnpm check`, the task's tests (`pnpm exec vitest run <files>`), and
  `pnpm check 2>&1 | grep -c 'effect('` printing `0`.

## Facts verified on this tree

- `effect` and the `@effect/*` packages are 4.1.4 (`pnpm-workspace.yaml` catalog); `@huggingface/gguf` is `^0.4.6` in
  `app/package.json:18` and bundled into the server by Rolldown (`app/build/server.ts`, `platform: 'node'`); it reads a
  local file through `fs` only with `allowLocalFile: true` (`app/server-legacy/lib/models/gguf.ts:202`, `:206`).
- The tables exist: `model_cache(path, stamp, summary_json, read_at)` (`app/server/db/migrations.ts:78`, `0003`) and
  `downloads(id, repo, revision, variant_key, name, quant, kind, dir, files_json, status, bytes_done, total_bytes,
  error, code, created_at, finished_at)` (`migrations.ts:172`, `0016`). No migration is added.
- `NodeHttpClient.layerNodeHttpOptions(options?: HttpAgentOptions)` (`NodeHttpClient.ts:1048`) builds `http.Agent`
  and `https.Agent` from the options (`makeAgent`, `:672`; `HttpAgentOptions extends Https.AgentOptions`, `:656`) and
  sends an `https:` URL through `https.request`; `LlamaHttp` (`app/server/llama/LlamaHttp.ts`) is built this way with
  `{ keepAlive: false }` and imports no `node:*`. A transport failure is `HttpClientError` with reason
  `TransportError { request, cause?, description? }` (`repos/effect/packages/effect/src/http/HttpClientError.ts:173`).
- Node 26's `http.Agent` takes `proxyEnv` (`{ HTTP_PROXY, HTTPS_PROXY, NO_PROXY, … }`): checked with `node -e` on this
  tree, a request to `http://hub.invalid/` went to the proxy, one to `127.0.0.1` with `NO_PROXY: '127.0.0.1'` went
  direct. `app/server-legacy/lib/env.ts:45-50` (`useEnvProxy`) adds `localhost`, `127.0.0.1`, `::1` to `NO_PROXY`.
- No non-test module of `app/server/` calls `fetch(` or touches `globalAgent`/`setGlobalProxyFromEnv` (`grep -rn`); the
  only `node:http` import is `app/server/http/HttpLive.ts:1`, with the one directive.
- The `nodeBuiltinImport` rule flags `node:crypto` (it names `crypto` of `effect`), `node:fs/promises` (`FileSystem`),
  `node:http` and `node:https` (`HttpClient`), not `node:os`, `node:util` or `node:ffi` (a scratch project extending
  `tsconfig.effect.json`). `Digest` (`repos/effect/packages/effect/src/crypto/Digest.ts:135-144`) has only
  `digest(algorithm, data: Uint8Array)` and `digestHex`; `FileSystem.ts` has no `statfs`.
- `FileSystem` (`repos/effect/packages/effect/src/FileSystem.ts`): `readDirectoryEntries` (`:296`, `DirectoryEntry {
  name, type }` with `type` `File | Directory | SymbolicLink | …`, `:538`, `:1023`), `stat` (follows symlinks;
  `Info.mtime: Option<Date>`, `size: ByteSize`, `:1091`), `realPath` (`:319`), `remove` (`:325`), `rename` (`:341`),
  `open` (`:259`), `stream(path, { offset, bytesToRead, chunkSize })` (`:375`), `makeDirectory` (`:190`). Node's errno
  maps to a `SystemError` tag (`ENOENT` → `NotFound`, `EACCES`/`EPERM` → `PermissionDenied`, `ENOTDIR` →
  `BadResource`, `ENOSPC` → `Unknown`), the `NodeJS.ErrnoException` kept as `cause`
  (`repos/effect/packages/platform/node-shared/src/internal/utils.ts:6-50`): ENOSPC is told by `cause.code`.
- `Cache.makeWith` (`repos/effect/packages/effect/src/Cache.ts:198`), `Cache.invalidateWhen` (`:1068`); the failure
  not kept as in `app/server/flags/Flags.ts:54-62`. `Semaphore.make` (`Semaphore.ts:424`), `withPermits` (`:85`).
  `Stream.timeoutOrElse` (`Stream.ts:2738`). `TestClock.adjust` (`repos/effect/packages/effect/src/testing/TestClock.ts:647`).
  `HttpClient.withScope` (`HttpClient.ts:2053`); `followRedirects` (`:2096`) is opt-in, so a client follows none.
- An `HttpRouter` route is interruptible unless declared `uninterruptible` (`repos/effect/packages/effect/src/http/HttpRouter.ts:254`):
  a client that leaves interrupts its handler, and a Hub call in the handler's scope is aborted with it.
- A `DELETE` endpoint may declare a payload (`HttpMethod.NoBody` is `GET | HEAD | OPTIONS | TRACE`,
  `repos/effect/packages/effect/src/http/HttpMethod.ts:45`). `HttpApiSchema.status(202)` is used by `ServerApi.ts:58`;
  `IdParam` (`packages/webui-shared/src/api/params.ts:4`) refuses anything but decimal digits ≥ 1 as the unknown route.
- `Schema.makeFilter` may return a string message (`Schema.ts:6804`; used by `packages/webui-shared/src/settings.ts:19`).
- `Shutdown.before(step)` registers a step run before the HTTP server stops, last registered first run
  (`app/server/runtime/Shutdown.ts:11-12`); `WsHub.publish` (`app/server/ws/WsHub.ts:34-39`); `ChatRuns` marks its
  orphans at its build and registers its step there (`app/server/chat/ChatRuns.ts`).
- `App.ts:30-37`: the services' tiers (`Layer.provideMerge`), `ChatRuns.layer` in the tier above `Supervisor.layer`;
  `ServicesTest` (`app/server/testing/services.ts:28-38`) mirrors them on `Db.layerAt(':memory:')`. The handlers are
  listed in `app/server/http/HttpLive.ts:41-48`.
- `modelsDir` defaults to `~/models` (`packages/webui-shared/src/settings.ts:40`); `homeDir` and `expandHome` are in
  `app/server/config/Home.ts:6`, `:16`; `profilePaths({ profile, home, cwd, path })` in
  `app/server/supervisor/command.ts:47`; `activeProfileId(state)` in `packages/webui-shared/src/server.ts:46`.
- `app/server/testing/` has no GGUF writer: the Nitro one is `app/server-legacy/lib/models/gguf.fixture.ts`
  (`writeGguf(path, kv, tensors)`, alignment 32). It also has `httpStub` (`testing/llama.ts:39`),
  `proxiedEnvironment` (`:223`), `nodeFetchText` (`:232`) and `later` (`:235`), used by `llama/LlamaHttp.test.ts`.
- The contract's `launch()` sets `HOME`, `XDG_*` and `LLAMA_WEBUI_TEST_MONITOR: 'stub'`, not
  `LLAMA_WEBUI_TEST_OFFLINE` (`app/server/contract/contract.test.ts:39-44`), and passes the rest of the user's
  environment (`app/server/testing/launch.ts:37`): an `HF_TOKEN` or `HF_ENDPOINT` of the user would reach a reply.
- The web: `/models` is in `MILESTONE_BY_PATH` (`app/src/app/routes.ts:50`) and not in `PORTED`
  (`app/src/app/router.tsx:23`); `app/src/lib/models.ts`, `app/src/lib/downloads.ts` and `app/src/features/models/*`
  still call the deleted `api('…')`; `features/models/hf/RepoView.tsx:136`, `:148` compare `error.code`;
  `features/tuning/ModelCard.tsx:45` (E8) and `features/system/ChecksCard.tsx`, `features/bench/BenchForm.tsx` (E7,
  E8) import from `@/lib/models` too. `app/src/lib/stem.ts` holds `stem` since E5.
- `scripts/poc/measure.ts` takes `--out` and `--skip-durations` (`:6`, `:316`).
- The legacy files still needed later: `app/server-legacy/lib/models/scan.ts` and `routes/api/setup.get.ts` (E8)
  import `lib/db/modelCache.ts`; `lib/tuning/*` and `lib/setup.ts` (E8) import `lib/models/{gguf,scan,sizes}.ts`;
  `lib/tuning/disk.ts` (E8) imports `fileRange` of `lib/proc.ts`; `lib/testing/seed.ts` and the legacy contract import
  `gguf.fixture.ts`.

## Reference files

- Legacy behaviour (read, never import), under `app/server-legacy/`: `lib/models/{gguf,sizes,scan,access,delete}.ts`
  and their tests (`gguf.test.ts`, `scan.test.ts`, `routes.test.ts`), `lib/models/gguf.fixture.ts`,
  `lib/db/{modelCache,downloads}.ts`, `lib/hf/{token,paths,variants,client,repo,downloader}.ts` and their tests
  (`hf.test.ts`, `downloader.test.ts`), `lib/llamaFetch.ts` and its `downloadFetch` tests, `lib/proc.test.ts`
  (`fileRange`), `lib/env.ts` (`useEnvProxy`) and its tests, `lib/boot.ts` (order), `lib/deps.ts` (the queue's
  callbacks to the hub), `routes/api/{models,hf,downloads}/**`, the models cases of `lib/contract/cases.ts`.
- The models: `app/server/llama/LlamaHttp.ts` and its test (a client of its own, its tests on `httpStub`),
  `app/server/flags/Flags.ts` (a `Cache.makeWith` whose failures are not kept), `app/server/profiles/ProfilesRepo.ts`
  and `app/server/chat/ConversationsRepo.ts` (a repository on `SqlClient`, a JSON column through
  `Schema.fromJsonString`), `app/server/chat/ChatRuns.ts` (fibers in the layer's scope, one lock, a shutdown step,
  orphans at the build), `app/server/monitor/Monitor.ts:401` (a test switch read with `Config`),
  `app/server/profiles/removeProfile.ts` (removing profiles and the default), `app/server/chat/http.ts` (a group's
  handlers), `packages/webui-shared/src/api/ChatApi.ts` and `ProfilesApi.ts` (a group and its errors).

## Review Focus

- **The app is stopped mid-download** (Ctrl-C while a GiB file comes in): the stop is not held back by the transfer,
  the `.part` stays with what was written, the row stays `downloading`, and the next start resumes it with a `Range`
  request instead of starting over. Test: Task 8, `SIGTERM during a download keeps its .part and the next start
  resumes it` in `app/server/lifecycle.test.ts`.
- **A proxy in the environment** (a company network): Hub calls and downloads go through `HTTPS_PROXY`, loopback and
  the `NO_PROXY` hosts stay direct, and llama-server is never reached through it. Test: Task 2, `a request goes through
  the proxy of the environment, loopback and NO_PROXY hosts direct` (and E5's `LlamaHttp` test stays green).
- **The CDN redirect and the token**: the token reaches the Hub's origin only, never the CDN a redirect points to, and
  a redirect loop ends. Test: Task 7, `downloads every shard, checks it and renames it into place; the token never
  reaches the CDN` and `a seventh redirect fails the item with Too many redirects from Hugging Face`.
- **Two clicks on Download** (or two tabs): the variant is queued once, the second request gets 409 `already-queued`,
  and the disk space check of the second sees the first's bytes. Test: Task 6, `concurrent or repeated requests for
  one variant queue it once; retry refuses a variant already queued` and `the disk space check counts the bytes the
  active items still have to write`.
- **Deleting a model while it is being downloaded or served**: a 409 `model-in-use`, nothing deleted; a symlinked
  model loses only its link. Test: Task 4, `a model the running server uses or a download writes is a 409, and nothing
  is deleted` and `deleting a symlinked model removes the link only`.

---

### Task 1: Schemas and the three groups

**Files:**

- Modify: `packages/webui-shared/src/models.ts`, `packages/webui-shared/src/hf.ts`, `packages/webui-shared/src/ws.ts`,
  `packages/webui-shared/src/hf.test.ts`, `packages/webui-shared/src/models.test.ts`,
  `packages/webui-shared/src/api/Api.ts` (`.add(ModelsApi).add(HfApi).add(DownloadsApi)` after `ChatApi`),
  `packages/webui-shared/src/index.ts`, `tsconfig.effect.json` (the third override)
- Create: `packages/webui-shared/src/api/ModelsApi.ts`, `packages/webui-shared/src/api/HfApi.ts`,
  `packages/webui-shared/src/api/DownloadsApi.ts`, `packages/webui-shared/src/api/models.test.ts` (the groups' query
  and payload rules)

**Interfaces:**

- Produces in `models.ts` (Schema, the same fields as today's interfaces): `ModelKind` (`'model' | 'mmproj'`),
  `ModelSummary`, `ModelEntry` (`{ ok: true, …ModelSummary } | { ok: false, path, relPath, files, fileBytes, error }`),
  `ModelList` (`{ dir, setting, home, scannedAt, models }`), `ModelWeights`, `ModelDetail`, `ModelProfileUse`,
  `ModelUsage`, `ModelDelete` (strict: `path` `String` min 1 `path required`, `deleteProfiles` `Boolean` default
  `false`), `ModelDeleted` (`{ deletedFiles, deletedProfiles }`), and `profileModelPath` unchanged.
- Produces in `hf.ts`: `HF_REPO_RE`, `parseHfInput`, `HfInput`, `isDownloadActive`, `vramFit`, `VramFit` unchanged;
  Schemas `HfTokenSource`, `HfStatus`, `HfSearchHit`, `HfFile`, `HfPresence`, `HfVariant`, `HfRepo`,
  `DownloadStatus`, `DownloadFile`, `DownloadItem` (`code: NullOr(String)`, no rule), `DownloadLive`, `DownloadList`
  (`{ items, live }`), and `DownloadRequest` (strict: `repo` matching `HF_REPO_RE` `Repository id expected
  (org/name)`, `revision` `/^[0-9a-f]{40}$/` `Commit sha expected`, `keys` 1 to 16 strings of 1 to 1024 characters).
- Produces in `ws.ts`: `WsMessage` members `{ type: 'download', payload: DownloadItem }`, `{ type:
  'download-progress', payload: NullOr(DownloadLive) }`, `{ type: 'download-deleted', payload: { ids: Array(Int) } }`.
- Produces the groups (endpoint names are the client's): `ModelsApi` (`models`): `list` `GET /api/models` →
  `ModelList`; `remove` `DELETE /api/models` payload `ModelDelete` → `ModelDeleted`, errors `ModelNotFound`,
  `ModelInUse`, `ProfileRunning`; `info` `GET /api/models/info` query `{ path }` (absolute, ends in `.gguf`, message
  `Absolute path to a .gguf file expected`) → `ModelDetail`, errors `ModelFileNotFound`, `ModelUnreadable`; `usage`
  `GET /api/models/usage` query `{ path }` (min 1 `path required`) → `ModelUsage`, error `ModelNotFound`. `HfApi`
  (`hf`): `repo` `GET /api/hf/repo` query `{ id, revision? }` (`id` a `makeFilter` `Invalid repository id: <id>`) →
  `HfRepo`; `search` `GET /api/hf/search` query `{ q }` (trimmed, 1 to 200, `Search text expected (200 characters at
  most)`) → `Array(HfSearchHit)`; `status` `GET /api/hf/status` → `HfStatus`; the Hub errors on `repo` and `search`
  (`HfGated`, `HfNotFound`, `HfUnauthorized`, `HfRateLimited`, `HfUnreachable`, `HfInvalidPath` on `repo`).
  `DownloadsApi` (`downloads`): `list` `GET /api/downloads` → `DownloadList`; `create` `POST /api/downloads` payload
  `DownloadRequest` → `{ items }` with `HttpApiSchema.status(202)`, errors the Hub's, `HfInvalidPath`, `ListedTwice`,
  `AlreadyQueued`, `DiskFull`; `clear` `POST /api/downloads/clear` → `{ deleted: Int }`; `remove`
  `DELETE /api/downloads/:id` (`IdParam`) → `HttpApiSchema.NoContent`, error `DownloadNotFound`; `retry`
  `POST /api/downloads/:id/retry` → `DownloadItem` with `status(202)`, errors `DownloadNotFound`, `NotFinished`,
  `AlreadyQueued`, `DiskFull`. Each error a `Schema.TaggedError` with the status and message of the Calls.

- [ ] **Step 1: Port and write the failing tests.** `hf.test.ts`: the nine tests of the inventory, same names
      (`parseHfInput: …` five, `vramFit: thresholds`, `vramFit: no GPU`, `DownloadRequestSchema: accepts a request`,
      `DownloadRequestSchema: rejects a bad repo, revision or empty keys`), the schema ones decoding with
      `Schema.decodeUnknownExit(DownloadRequest)` and asserting the failure's message (`Repository id expected
      (org/name)`, `Commit sha expected`, an empty `keys` and 17 keys refused, an unknown key refused). `models.test.ts`:
      `profileModelPath fills an empty cwd with models_dir and keeps paths relative under the cwd` unchanged; add
      `ModelDelete defaults deleteProfiles to false and refuses an empty path with path required`. `api/models.test.ts`:
      `the search query is trimmed and refused when empty or over 200 characters`, `the repo id names the id it
      refuses`, `the info path must be absolute and end in .gguf`, `a DownloadItem with any stored code decodes`, and
      `every new endpoint is in the API definition` (`HttpApi.reflect` lists the twelve `METHOD /path`).
- [ ] **Step 2:** they fail (`pnpm exec vitest run packages/webui-shared`). **Step 3: Implement** the schemas, errors and
      groups; `models.ts` and `hf.ts` into the third override. **Step 4:** the gates. Commit
      `feat(shared): Describe the models, the Hub and the downloads as schemas`.

### Task 2: The Hugging Face HTTP client

**Files:**

- Create: `app/server/hf/HfHttp.ts`, `app/server/hf/HfHttp.test.ts`, `app/server/hf/token.ts`,
  `app/server/hf/token.test.ts`

**Interfaces:**

- Produces `class HfHttp extends Context.Service<HfHttp, HttpClient.HttpClient.With<HttpClientError.HttpClientError,
  Scope.Scope>>()('@llama-webui/app/server/hf/HfHttp')` with `HfHttp.layer: Layer<HfHttp>` (reads through `Config`:
  `LLAMA_WEBUI_TEST_OFFLINE`, the six proxy variables; `keepAlive: true`, `proxyEnv` with loopback added to the
  no-proxy list; offline: every request fails with `TransportError({ request, description: 'fetch failed' })`).
- Produces in `token.ts`: `HfToken = { token: string | null; source: HfTokenSource }`; `hfEndpoint: Effect<string>`
  (`HF_ENDPOINT` trimmed, trailing slashes removed, default `https://huggingface.co`); `hfTokenPath: Effect<string>`
  (`HF_TOKEN_PATH`, else `$HF_HOME/token`, else `$XDG_CACHE_HOME/huggingface/token`, else `<home>/.cache/huggingface/token`);
  `hfToken: Effect<HfToken, never, FileSystem>` (`HF_TOKEN`, else `HUGGING_FACE_HUB_TOKEN`, trimmed, source `env`;
  else the file trimmed, source `file`; else null; read on every call); `hubHeaders(token: string | null):
  Record<string, string>` (`user-agent: llama-webui`, `authorization: Bearer <token>` when there is one).

- [ ] **Step 1: Write the failing tests.** `token.test.ts` (a `ConfigProvider.fromEnv({ env })` per test, a temp
      folder): the three Nitro token tests, same names: `HF_TOKEN first, then the hf token file` (the legacy
      `HUGGING_FACE_HUB_TOKEN` second, a blank variable skipped, the file trimmed, source `file`, none `null`), `token
      file location follows the hf CLI` (the four cases above in order), `endpoint` (trimmed, `https://hub.test///`
      → `https://hub.test`, default); add `the token is read again on every call` (the file written after a first
      call is seen by the second). `HfHttp.test.ts` (real time, `httpStub`, `proxiedEnvironment`): the rewrites of
      the four `downloadFetch` tests and the two `useEnvProxy` tests: `a redirect is the response, with its location,
      not followed` (302 `location` read, the target never asked), `sends the headers, streams the body, and leaving
      the scope during it aborts the request` (the stub sees the headers and its `close`), `an https URL goes through
      node:https (TLS against a plain HTTP server fails)` (a `TransportError`), `the requests are HTTP/1.1` (the stub
      records `req.httpVersion` `1.1`), `a request goes through the proxy of the environment, loopback and NO_PROXY
      hosts direct` (a proxy stub on loopback: `http://hub.invalid/x` reaches it with that absolute URL; a request to
      the `httpStub` on `127.0.0.1` reaches the stub directly; a host of `NO_PROXY` is not sent to the proxy), `no
      proxy variable, nothing goes to a proxy`, `a silence of 3 s before the headers and between two chunks does not
      end the request` (as `LlamaHttp.test.ts`, timeout 10 000), `with LLAMA_WEBUI_TEST_OFFLINE=1 every request fails
      with fetch failed` (a `TransportError` whose description is `fetch failed`, the stub never asked).
- [ ] **Step 2:** they fail. **Step 3: Implement.** **Step 4:** the gates, and `pnpm exec vitest run
      app/server/llama/LlamaHttp.test.ts` still green (`stays direct when the environment sets a proxy`). Commit
      `feat(server): Reach Hugging Face through a client of its own, behind the proxy of the environment`.

### Task 3: The GGUF reader, the sizes, the scan and its cache table

**Files:**

- Create: `app/server/testing/gguf.ts` (port of `gguf.fixture.ts`: `writeGguf(path, kv, tensors): Promise<void>`,
  `KvValue`, alignment 32), `app/server/models/gguf.ts`, `app/server/models/gguf.test.ts`,
  `app/server/models/sizes.ts`, `app/server/models/sizes.test.ts`, `app/server/models/GgufReader.ts`,
  `app/server/models/ModelCacheRepo.ts`, `app/server/models/ModelCacheRepo.test.ts`, `app/server/models/scan.ts`,
  `app/server/models/scan.test.ts`

**Interfaces:**

- Produces in `sizes.ts`: `EXPERTS` (`/ffn_(gate|up|down)_(ch)?exps/`), `tensorBytes(tensors, dataOffset, fileBytes):
  number[]`, `weightSizes(tensors): WeightSizes` (ported unchanged).
- Produces in `gguf.ts`: `TensorInfo`, `ModelInfo` (the Nitro shape, `files` included), `ParsedShard`,
  `parseModel(path, shards, sizes, parameterCount): Omit<ModelInfo, 'files'>` (pure, ported), `shardFiles(path):
  ReadonlyArray<string>` (all parts of a `-00001-of-0000N.gguf` name, else the path), and the server-side
  `class ModelReadError extends Schema.TaggedError<…>()('ModelReadError', { message: Schema.String })`.
- Produces `class GgufReader extends Context.Service<GgufReader, { read(path): Effect<ModelInfo, ModelReadError>;
  stamp(path): Effect<string, ModelReadError> }>` keyed `@llama-webui/app/server/models/GgufReader`,
  `GgufReader.layer: Layer<GgufReader, never, FileSystem>`: `stamp` stats every part (`<mtime ms>:<size>` joined by
  `|`), `read` compares it with the cached entry (`Cache.makeWith`, capacity 8, failure not kept) and reads with
  `@huggingface/gguf` in `Effect.tryPromise` on a miss.
- Produces `class ModelCacheRepo extends Context.Service<ModelCacheRepo, { get(path): Effect<Option<{ stamp; summary:
  ModelSummary }>>; put(path, stamp, summary): Effect<void>; prune(keep: ReadonlyArray<string>): Effect<number> }>`
  on `SqlClient` (`summary_json` through `Schema.fromJsonString(ModelSummary)`; a row that no longer decodes is a miss;
  `INSERT OR REPLACE`; `read_at` from the `Clock`).
- Produces in `scan.ts`: `groupGgufFiles(relPaths): Array<{ main; files; missing }>` (pure, ported), `toSummary(info,
  relPath): ModelSummary` (ported), `scanModels(root: string): Effect<ReadonlyArray<ModelEntry>, never, FileSystem |
  Path | GgufReader | ModelCacheRepo>` (the E6 scan line: names starting with `.` skipped, directory symlinks not
  followed, a `.gguf` symlink kept when `stat` says `File`, unreadable folders skipped, incomplete shard sets `ok:
  false` `missing shard: <names>`, the reads in parallel (`Effect.forEach` with `concurrency: 'unbounded'`), a cache
  row reused on an equal stamp, a success put, a failure never put, the rows of vanished files pruned; a missing or
  unreadable root gives `[]`; entries sorted by main relative path).

- [ ] **Step 1: Port and write the failing tests.** `sizes.test.ts`: `weightSizes: shared experts stay with the layer
      (--n-cpu-moe moves only _exps / _chexps)`, `weightSizes: groups tensors by layer, experts apart`, `tensorBytes:
      last tensor ends at the end of the file` (same assertions). `gguf.test.ts` (files by `writeGguf` in a temp
      folder, `layer(GgufReader.layer …)`): the fifteen `readModel` tests of the inventory, same names, `readModel`
      being `GgufReader.read` (`reads a dense model's metadata and tensors`, `reads a hybrid model:
      full_attention_interval, ssm tensors, nextn layers`, `sums the shards of a -00001-of-00002 model`, `a missing
      shard is a ModelReadError` with `file not found: <shard>`, `an absent file is a ModelReadError`, `a file that is
      not a GGUF is a ModelReadError` with `unreadable GGUF: …`, `the cache returns the same object until the file
      changes`, `a changed second shard is re-read even when the first is untouched`, `the cache keeps the last 8 models
      only` (the first read again after eight others is a new object), `a file behind a directory the user cannot enter
      is told apart from a missing one` (`permission denied: …`; skipped under root), the four vocabulary tests, `a
      multimodal projector is kind mmproj; a chat template is noticed`); add `a failed read is not cached: the file
      fixed, the next read succeeds` and `a path through a regular file is file not found (ENOTDIR)`.
      `ModelCacheRepo.test.ts`: `put then get returns the summary and its stamp`, `a row written by the Nitro server
      reads back` (a `summary_json` and a fractional stamp inserted by SQL), `a row that no longer decodes is a miss`,
      `prune deletes the rows of the paths not kept and counts them`. `scan.test.ts`: `groupGgufFiles groups shards
      under the first and reports missing ones`, `scanModels skips hidden dirs, classifies mmproj, reports unreadable
      files and reuses the cache` (same names); add `scanModels follows a .gguf symlink to a regular file but not a
      directory symlink`, `scanModels reports an incomplete shard set as missing shard`, `scanModels prunes the cache
      rows of vanished files`, `scanModels never caches a failed read`, `a missing models folder scans as empty`.
- [ ] **Step 2:** they fail. **Step 3: Implement.** **Step 4:** the gates. Commit `feat(server): Read GGUF models,
      scan the models folder and keep the summaries in SQLite`.

### Task 4: The models over HTTP

**Files:**

- Create: `app/server/models/access.ts`, `app/server/models/usage.ts`, `app/server/models/http.ts`,
  `app/server/models/http.test.ts`
- Modify: `app/server/http/HttpLive.ts` (`ModelsHandlers`), `app/server/App.ts`, `app/server/testing/services.ts`

**Interfaces:**

- Consumes: Task 1's `ModelsApi`, Task 3's `scanModels`, `GgufReader`, `ModelCacheRepo`, `SettingsRepo.get`,
  `ProfilesRepo`, `Supervisor.state`, `profilePaths`, `homeDir`/`expandHome`, `removeProfile`-like removal of
  profiles; and the queue's active items as `ActiveWrites` (below), which Task 6 provides from `DownloadsRepo.active`.
- Produces in `access.ts`: `modelsRoot: Effect<{ dir: string; setting: string }, never, SettingsRepo>` (`~`
  expanded), `findEntry(models, root, path): Effect<ModelEntry, ModelNotFound>` (a scanned main path only; a file of
  the entry resolving outside the root is `ModelNotFound`).
- Produces in `usage.ts`: `class ActiveWrites extends Context.Service<ActiveWrites, { active: Effect<ReadonlyArray<DownloadItem>>
  }>` keyed `@llama-webui/app/server/models/ActiveWrites` with `ActiveWrites.layerNone` (no download: until Task 6),
  `modelUsage(entry): Effect<ModelUsage, never, …>` (profiles by `profilePaths` and `realPath`, role `model` checked
  first; `blocked` the running server's profile message, then `A download in progress writes it`, else null),
  `deleteModel(entry, root, deleteProfiles): Effect<ModelDeleted, ModelInUse | ProfileRunning, …>` (the files first,
  a symlink's link only, then the folders left empty up to the root, then the profiles and the default reset; a file
  that cannot be removed dies: 500).
- Produces `ModelsHandlers` (`list`: `{ dir, setting, home, scannedAt (Clock), models }`; `remove`; `info`: the summary
  with `relPath` relative to the root when inside it, else absolute; `ModelFileNotFound` when `stat` says missing or
  not a `File`; `ModelUnreadable` from `ModelReadError`; `usage`). Tiers of `App.ts`: `GgufReader.layer` and
  `ModelCacheRepo.layer` with the repositories; `ActiveWrites.layerNone` until Task 6. `ServicesTest` the same.

- [ ] **Step 1: Port and write the failing tests** (`models/http.test.ts`, the test server on `ServicesTest`, a models
      folder of `writeGguf` files, `HOME` and `modelsDir` set): the five Nitro route tests, same names except the
      fifth: `deleting a split model removes every part and the folders left empty, not the models folder`, `only a
      model the scan found can be deleted: another path is a 404`, `usage lists the profiles opening the file as model
      or projector, through a relative path or a symlink`, `deleteProfiles deletes the profiles using the model and
      resets the default; false keeps them`, and `a model the running server uses or a download writes is a 409, and
      nothing is deleted` (rewritten: the benchmark half moves to E7; the download half with an `ActiveWrites` whose
      active item writes the file; the message `The running server uses it (profile “<name>”): stop it first` with the fake
      llama-server ready through the supervisor). Add: `the list holds the scan with dir, setting, home and
      scannedAt`, `a missing models folder lists no model`, `deleting a symlinked model removes the link only`, `a
      file that cannot be removed answers 500 and keeps the profiles` (a `FileSystem` over the Node one whose `remove`
      fails for the second shard), `info answers the detail of a model and of a file outside the models folder, its
      relPath absolute` (design choice), `info refuses a relative path or another extension with a 400
      RequestInvalid`, `info of a missing file or a folder is a 404 File not found`, `info of a file that is not a GGUF
      is a 422 with the read error`, `usage without a path or with an empty one is a 400 RequestInvalid path required`,
      `usage of a later shard is a 404 Model not found`.
- [ ] **Step 2:** they fail. **Step 3: Implement** the handlers and the wiring. **Step 4:** the gates. Commit
      `feat(server): Serve the models: list, detail, usage and deletion`.

### Task 5: The Hub client and its group

**Files:**

- Create: `app/server/hf/paths.ts`, `app/server/hf/paths.test.ts`, `app/server/hf/variants.ts`,
  `app/server/hf/variants.test.ts`, `app/server/hf/HfClient.ts`, `app/server/hf/HfClient.test.ts`,
  `app/server/hf/repo.ts`, `app/server/hf/http.ts`, `app/server/hf/http.test.ts`, `app/server/testing/hub.ts` (a fake
  Hub: `node:http` on loopback, `/api/models?…`, `/api/models/<id>/revision/<rev>?blobs=true`, `/api/whoami-v2`,
  `/<repo>/resolve/<sha>/<path>` with `Range`, a redirect to a second "CDN" server, failures and silences to order,
  the requests it saw with their headers; runnable as `node app/server/testing/hub.ts --port <n> --dir <folder>` for
  Task 9's look)
- Modify: `app/server/http/HttpLive.ts` (`HfHandlers`), `app/server/App.ts`, `app/server/testing/services.ts`

**Interfaces:**

- Consumes: `HfHttp`, `hfToken`, `hfEndpoint`, `hubHeaders` (Task 2), the errors of Task 1.
- Produces in `paths.ts`: `repoDir(modelsDir, repo): string` (`<modelsDir>/<org>/<name>`, the repo already checked by `HF_REPO_RE`),
  `fileDest(dir, path): Effect<string, HfInvalidPath>` (absolute or leaving `dir` refused), `partPath(dest)`,
  `sizeOf(path): Effect<Option<number>, never, FileSystem>`.
- Produces in `variants.ts`: `RepoVariant`, `groupRepoFiles(files): { variants; projectors }` (ported, pure).
- Produces `class HfClient extends Context.Service<HfClient, { status: Effect<HfStatus>; search(q):
  Effect<ReadonlyArray<HfSearchHit>, HubError>; repoFiles(id, revision): Effect<RepoFiles, HubError> }>` keyed
  `@llama-webui/app/server/hf/HfClient`, `HfClient.layer: Layer<HfClient, never, HfHttp | FileSystem>`; `HubError =
  HfGated | HfNotFound | HfUnauthorized | HfRateLimited | HfUnreachable`; `hubError(response, { repo?, hasToken }):
  HubError` (the order of `hfHttpError`: `x-error-code` `GatedRepo` or 403, `RepoNotFound`/`RevisionNotFound`/
  `EntryNotFound` or 404, 401, 429, else 502 with `x-error-message`); each API call 10 s (`Effect.timeoutOrElse`,
  `Hugging Face unreachable: no answer in 10 s`), its 200 decoded with a Schema (else `Hugging Face sent an invalid
  response (<path>)`); search `limit=30` and the four `expand[]`; the whoami answer cached per token in a
  `SynchronizedRef<Map>` (a 401 cached `tokenInvalid: true`, another failure not cached, `user: null`).
- Produces in `repo.ts`: `describeRepo(id, revision): Effect<HfRepo, HubError | HfInvalidPath, HfClient | FileSystem |
  Path | SettingsRepo | ActiveWrites>` (the `present` state of each variant, the `queued` flag from the queue's active
  items: `ActiveWrites` of Task 4) and `downloadInputs(request): Effect<ReadonlyArray<NewDownload>, HubError |
  HfInvalidPath | ListedTwice, …>` (`NewDownload` = `{ repo, revision, key, name, quant, kind, dir, files }`, defined here; re-read at the pinned revision, canonical repo id and resolved sha, files already
  on disk with the right size left out, a variant with nothing left skipped, `No GGUF “<key>” in <repo>`).
- Produces `HfHandlers` (`repo`, `search`, `status`). `HfClient.layer` and `HfHttp.layer` join the tier of `LlamaHttp`.

- [ ] **Step 1: Port and write the failing tests.** `paths.test.ts`: `downloads go to <modelsDir>/<org>/<name>`, `a
      path cannot leave the repo folder` (same assertions). `variants.test.ts`: `groupRepoFiles: single files, shard
      sets, projectors; other files ignored; smallest first`, `imatrix files in GGUF format are not offered as variants
      (#31)`. `HfClient.test.ts` (the fake Hub, real time; `HF_ENDPOINT` its URL): the four Nitro tests, same names:
      `repo files: sizes and sha256 from the blobs listing, pinned commit`, `search: GGUF filter, most downloaded
      first` (add the assertion that the query holds `limit=30` and the four `expand[]`), `errors carry a code` (now:
      each status gives its tag and message, `x-error-code` before the status, the login hint without a token),
      `status: token source and account, a rejected token is reported`; add `a whoami that fails on the network is not
      cached`, `a 502 carries the x-error-message`, `a Hub call without an answer in 10 s is HfUnreachable` (the
      `TestClock`), `a 200 that is not the expected JSON is Hugging Face sent an invalid response`, `a Hub call is
      aborted when its scope closes` (the fake Hub sees the `close`). `hf/http.test.ts` (test server on `ServicesTest`
      with the fake Hub): `repo answers the variants with their present state none, partial and complete, its url and
      dir`, `repo with an invalid id is a 400 RequestInvalid`, `repo of a gated repository is a 403 HfGated`, `search
      refuses an empty or a 201-character text with a 400`, `a client that leaves aborts the Hub call`, `status without
      a token asks nothing of the Hub`.
- [ ] **Step 2:** they fail. **Step 3: Implement.** **Step 4:** the gates. Commit `feat(server): Search Hugging Face
      and describe a repository's GGUF variants`.

### Task 6: The downloads table and the queue's bookkeeping

**Files:**

- Create: `app/server/downloads/DownloadsRepo.ts`, `app/server/downloads/DownloadsRepo.test.ts`,
  `app/server/downloads/freeSpace.ts`, `app/server/downloads/freeSpace.test.ts`, `app/server/downloads/Downloads.ts`,
  `app/server/downloads/Downloads.test.ts`
- Modify: `app/server/models/usage.ts` (`ActiveWrites.layer` from `DownloadsRepo.active`)

**Interfaces:**

- Produces `class DownloadsRepo extends Context.Service<DownloadsRepo, { create(input: NewDownload): Effect<DownloadItem>; get(id):
  Effect<Option<DownloadItem>>; list: Effect<ReadonlyArray<DownloadItem>>; active: Effect<ReadonlyArray<DownloadItem>>;
  next: Effect<Option<DownloadItem>>; setStatus(id, status, { error?, code? }): Effect<DownloadItem>; fileDone(id,
  path): Effect<DownloadItem>; requeue(id): Effect<DownloadItem>; remove(id): Effect<void>; clearFinished:
  Effect<ReadonlyArray<number>> }>` on `SqlClient` (the Nitro SQL: `next` by `status = 'downloading' DESC, id`;
  `files_json` through `Schema.fromJsonString`; times from the `Clock`; `finished_at` set by a final status).
- Produces in `freeSpace.ts`: `freeBytesOf(dir): Effect<number | null>` (`statfs` of the folder or its nearest
  existing parent, `bavail × bsize`; null when none answers), the one `node:fs/promises` import with its directive.
- Produces `class Downloads extends Context.Service<Downloads, { list: Effect<DownloadList>; enqueue(inputs):
  Effect<ReadonlyArray<DownloadItem>, AlreadyQueued | DiskFull>; retry(id): Effect<DownloadItem, DownloadNotFound |
  NotFinished | AlreadyQueued | DiskFull>; remove(id): Effect<void, DownloadNotFound>; clear: Effect<number> }>` keyed `@llama-webui/app/server/downloads/Downloads`;
  `Downloads.layerWith({ freeBytes?, marginBytes?, retryDelays?, stall?, liveEvery? })` and `Downloads.layer`
  (`freeBytesOf`, 1 GiB, `[2, 4, 8, 16, 30]` s, 60 s, 250 ms). Needs `DownloadsRepo`, `HfHttp`, `WsHub`,
  `FileSystem`, `Path`, `Shutdown`. In this task the transfer of an item is a parameter (`transfer?` of `layerWith`,
  Task 7 gives the real one): the loop, the lock and the messages are this task's.
- Behaviour, the E6 "Background work" lines and `app/server-legacy/lib/hf/downloader.ts`: `enqueue` and `retry` under
  the semaphore (already-queued by repo and key, then the disk check: bytes still to write minus existing `.part`
  bytes, plus the active items' remaining bytes, plus the margin, `DiskFull` with `fmtBytes`; an unknown free space
  skips it), their rows created in one uninterruptible step and each published `download`; the loop forked in the
  layer's scope (`Effect.forkIn`), started by `enqueue`, `retry` and the build, started again when `dirty`, an item
  left `downloading` first; `remove` in one step under the queue's lock: a running item is cancelled (its transfer
  interrupted, the queue then deletes its `.part`, its placed files and the folders left empty deepest first, marks it
  `canceled`, publishes), a queued one marked `canceled` (files deleted, a deletion failure dies after the mark and
  the publish), any other removed with its files kept (`download-deleted`); `clear` publishes `download-deleted` with
  the ids ascending when there are any; a failure escaping the loop logged `[llama-webui] download queue stopped:` and
  the item picked up on the next start; `ActiveWrites.layer` reads `DownloadsRepo.active`.

- [ ] **Step 1: Port and write the failing tests.** `DownloadsRepo.test.ts`: `create, get and list by id`, `next takes
      an item left downloading first, then the oldest queued`, `fileDone adds the file's size to bytesDone`, `requeue
      marks every file not done and clears the error, code and finishedAt`, `clearFinished deletes done, error and
      canceled rows and returns their ids`, `a row written by the Nitro server reads back`. `freeSpace.test.ts`: `the
      free space of a folder that does not exist yet is its nearest parent's`. `Downloads.test.ts` (`ServicesTest`, a
      `transfer` the test controls, a `WsHub` subscriber collecting the messages): from `downloader.test.ts`, same
      names: `concurrent or repeated requests for one variant queue it once; retry refuses a variant already queued`,
      `retry checks the disk space like a new download`, `refuses a duplicate and a download that does not fit on the
      disk; skips files already there`, `remove and clear finished items`, `cancel: a running item stops and its files
      are deleted; a queued one never starts`. Add: `an enqueue whose every file is on disk creates no row and answers
      an empty list`, `retry of a done or queued item is NotFinished`, `the disk space check counts the bytes the active
      items still have to write`, `the disk space check keeps a 1 GiB margin`, `a queued item whose files cannot be
      deleted is still marked and published canceled, and the call dies`, `a failure that escapes the loop is logged
      download queue stopped and the item is picked up on the next start`, `work added while the loop runs is taken
      without a new call`, `the layer resumes the item left downloading first, then the queued ones in order`, `each
      status change is published as download, a removal as download-deleted, in that order`.
- [ ] **Step 2:** they fail. **Step 3: Implement.** **Step 4:** the gates. Commit `feat(server): Queue the downloads
      in SQLite, one at a time`.

### Task 7: The transfer of a file

**Files:**

- Create: `app/server/downloads/hash.ts`, `app/server/downloads/transfer.ts`, `app/server/downloads/transfer.test.ts`
- Modify: `app/server/downloads/Downloads.ts` (the real transfer by default)

**Interfaces:**

- Consumes: `HfHttp`, `hfToken`, `hfEndpoint`, `hubHeaders`, `hubError` (Tasks 2 and 5), `fileDest`, `partPath`
  (Task 5), `DownloadsRepo.fileDone` (Task 6).
- Produces in `hash.ts`: `Sha256 = { update(chunk: Uint8Array): void; copy(): Sha256; hex(): string }` and
  `sha256(): Sha256` over `createHash('sha256')`, the one `node:crypto` import with its directive.
- Produces in `transfer.ts`: `transferItem(item, report): Effect<void, TransferFailed, HfHttp | FileSystem | Path |
  DownloadsRepo>` where `TransferFailed { message, code, status }` is a server-side tagged error and `report` receives
  the live phases (`downloading` with the bytes so far, `verifying`, `retrying` with `retryAt`); per file:
  `<endpoint>/<repo>/resolve/<sha>/<segments URL-encoded>` with `user-agent: llama-webui`, up to 6 redirects followed
  by hand (the token only to the endpoint's origin; a seventh: `Too many redirects from Hugging Face`, 502
  `hf-unreachable`); the `.part` rules of the E6 line (a `.part` larger than the file deleted first; `Range:
  bytes=<offset>-`; a 206 whose `content-range` does not start at the offset deletes the `.part` and retries; a 200 to
  a ranged request rewrites from zero, hash reset; 416 deletes the `.part` and retries from zero); the body written
  through `FileSystem.open` (`flag: 'a'`, or `'w'` from zero) and hashed as it goes, the hash state kept across
  attempts when it covers exactly the `.part`, else the `.part` re-read with `FileSystem.stream(path, { chunkSize: 1
  MiB })` (phase `verifying`); on a size match the digest compared (`Checksum mismatch for <path>: the file was
  deleted`, 422 `checksum-mismatch`, the `.part` deleted) else renamed and `fileDone`; the stall (Calls); the retries
  (Calls: 408, 429, 5xx, network, stall, short body keeping the `.part`, long body deleting it, empty body, bad range,
  416, a write error other than ENOSPC; the budget reset after an attempt that received data; logged `… retrying`);
  the non-transient ends (the Hub's `hf-gated`, `hf-not-found`, `hf-unauthorized`; ENOSPC by `cause.code` as 507
  `Disk full` `disk-full`; anything else its message with `download-failed`). `Downloads` publishes `report` as
  `download-progress` at most once per 250 ms (the `Clock`), `bps` = 0.7 × previous + 0.3 × instantaneous, and logs
  `[llama-webui] download <repo>/<key> failed: <message>`.

- [ ] **Step 1: Port and write the failing tests** (`transfer.test.ts`, the fake Hub of Task 5, `Downloads.layerWith`
      on `ServicesTest`; real time except where the `TestClock` is named). From `downloader.test.ts`, same names:
      `downloads every shard, checks it and renames it into place; the token never reaches the CDN`, `resumes an
      existing .part with a Range request`, `starts over when the server ignores the Range header`, `a connection cut
      mid-file is resumed where it stopped`, `a body that ends early without an error is resumed, not started over; the
      hash is not read again`, `network errors are retried, then the item fails once the retries are spent`, `a gated
      repo fails at once, with its code`, `a checksum mismatch deletes the file`, `retrying a canceled split model
      downloads again the shards the cancel deleted`, `after a restart, the next queue resumes the item from its .part`
      (a second layer on the same database and folder). Add, from "Not covered by a test": `a seventh redirect fails
      the item with Too many redirects from Hugging Face`, `a 416 deletes the .part and starts the file from zero`, `a
      206 that does not start at the offset deletes the .part and retries`, `a .part larger than the file is deleted
      before the request`, `a body longer than the file deletes the .part and retries`, `408, 429 and 5xx answers are
      retried` (the Hub and the CDN), `the retry budget is reset after an attempt that received data` (`TestClock`:
      six failures with data in between succeed), `no data for 60 s is retried as no data for 60 s` (`TestClock`, after
      the headers are seen), `the pauses are 2, 4, 8, 16 then 30 s, each published as retrying with its retryAt`
      (`TestClock`), `progress is published at most once per 250 ms with a smoothed bps` (`TestClock`), `ENOSPC fails
      the item with 507 Disk full` (a `FileSystem` whose write fails with `ENOSPC`), `a local error fails the item with
      download-failed and is logged failed`, `a retry is logged retrying with the file and the message`, `the verifying
      re-read hashes exactly the .part, in 1 MiB chunks` (the rewrite of the two `fileRange` tests: a `.part` of 2.5
      MiB left by another run is hashed through three chunks of at most 1 MiB, and the digest matches).
- [ ] **Step 2:** they fail. **Step 3: Implement.** **Step 4:** the gates. Commit `feat(server): Download a model's
      files, resumed, checked and retried`.

### Task 8: The downloads over HTTP, the WebSocket and the boot

**Files:**

- Create: `app/server/downloads/http.ts`, `app/server/downloads/http.test.ts`
- Modify: `app/server/http/HttpLive.ts` (`DownloadsHandlers`), `app/server/App.ts`, `app/server/testing/services.ts`,
  `app/server/contract/cases.ts`, `app/server/contract/contract.test.ts`, `app/server/contract/golden.json`,
  `app/server/lifecycle.test.ts`

**Interfaces:**

- Produces `DownloadsHandlers` (`list`; `create`: `downloadInputs` then `enqueue`, 202 `{ items }`; `clear` `{ deleted
  }`; `remove` 204; `retry` 202). Tiers of `App.ts`: `HfHttp.layer` and `HfClient.layer` with `LlamaHttp`;
  `DownloadsRepo.layer` with the repositories; `Downloads.layer` in the tier of `ChatRuns.layer` (its step registered
  with the others, its fiber ended before the hub, the supervisor and the database); `ActiveWrites.layer` above it.
  `ServicesTest` the same, with `Downloads.layerWith` (no real `statfs`, the fake Hub's endpoint).
- The contract: `launch()` adds `LLAMA_WEBUI_TEST_OFFLINE: '1'`, `HF_TOKEN: ''`, `HUGGING_FACE_HUB_TOKEN: ''`,
  `HF_TOKEN_PATH: <tmp>/no-token`, `HF_ENDPOINT: 'https://huggingface.co'`; `beforeAll` writes `<home>/models/m.gguf`
  (`writeGguf`, the default `~/models`).

- [ ] **Step 1: Write the failing tests.** `downloads/http.test.ts` (test server on `ServicesTest`, the fake Hub, a `/ws`
      client of `testing/ws.ts`): `a valid download request stores the canonical repo id and the resolved sha and
      answers 202 with the items` (defects.md E6: "No test posts a valid download"), `a request naming a key the repo
      lacks is a 404 No GGUF`, `a key listed twice is a 400`, `an invalid request is a 400 RequestInvalid` (bad repo,
      revision, 17 keys, unknown key), `delete of a running item cancels it and answers 204 at once`, `delete of a
      finished item removes it and keeps its files`, `delete of an unknown id is a 404 Download not found, of abc the
      unknown route`, `retry of a failed item answers 202 with it queued`, `clear answers the count`, `the queue's
      messages reach a /ws client: download, download-progress and download-deleted`, `with LLAMA_WEBUI_TEST_OFFLINE=1
      a download request is a 502 Hugging Face unreachable: fetch failed`.
  - Contract: one case per new endpoint (`covers`): `GET /api/models` (one model), `GET /api/models/info?path=<home>/
    models/m.gguf`, `GET /api/models/usage?path=<home>/models/m.gguf`, `DELETE /api/models` `{"path":""}` (violation)
    and `{"path":"<tmp>/nope.gguf"}` (refusal 404), `GET /api/models/info?path=rel.gguf` (violation), `GET
    /api/models/usage` (violation), `GET /api/hf/status`, `GET /api/hf/search?q=qwen` and `GET /api/hf/repo?id=org/repo`
    (refusal 502 offline), `GET /api/hf/search?q=` and `GET /api/hf/repo?id=x` (violation), `GET /api/downloads`,
    `POST /api/downloads` `{"repo":""}` (violation) and a valid body (refusal 502 offline), `POST /api/downloads/clear`
    (write), `DELETE /api/downloads/999999` and `POST /api/downloads/999999/retry` (refusal 404); recorded with
    `UPDATE_GOLDEN=1 pnpm exec vitest run app/server/contract/contract.test.ts`, then the diff of `golden.json` read:
    new cases only, plus those that move from the 404 of a missing route to the models' answers.
  - `lifecycle.test.ts`: `SIGTERM during a download keeps its .part and the next start resumes it` (the build with
    `HF_ENDPOINT` the fake Hub, a token in the environment, a download posted, the fake Hub holding the body after a
    first chunk; SIGTERM: exit 0 in under 2 s, the `.part` holds the first chunk, the row `downloading` in the data
    folder's database; a second launch on the same folder: the fake Hub sees `Range: bytes=<first chunk>-`, the item
    ends `done`) (Review Focus).
- [ ] **Step 2:** they fail. **Step 3: Implement** the handlers and the wiring. **Step 4:** the gates, `pnpm build`
      before the build-driven suites. Commit `feat(server): Serve the downloads and push their progress`.

### Task 9: The Models page, the downloads sheet and the model picker

**Files:**

- Modify: `app/src/lib/models.ts`, `app/src/lib/downloads.ts`, `app/src/features/models/*.tsx`,
  `app/src/features/models/hf/*.tsx`, `app/src/features/profiles/ProfileForm.tsx`,
  `app/src/features/profiles/ProfilesPage.tsx`, `app/src/app/router.tsx`, `app/src/app/routes.ts`, `app/tsconfig.json`
  (if needed), and the golden's entry modulepreload list
- Create: `app/src/lib/models.test.ts`, `app/src/lib/downloads.test.ts`

**Interfaces:**

- Consumes the client's `api.models.*`, `api.hf.*`, `api.downloads.*` through `call` (`app/src/lib/api.ts`), `errorTag`,
  and the `download*` messages of the web's WebSocket.
- Produces `makeModelsStore(calls)` and `makeDownloadsStore(calls)` (the stores built on the calls they are given, as
  `makeChatStore`), with `useModels`, `useDownloads`, `readable`, `matchingProjector`, `downloadPath`,
  `queueProgress`, `startDownloadsSync` kept by name for the E7 and E8 pages.

- [ ] **Step 1: Write the failing tests** (on `makeCall(Api, fetchImpl)`, as `lib/chat.test.ts`): `models.test.ts`:
      `reload stores the list and keeps the last error`, `deleteModel sends the path and deleteProfiles`,
      `matchingProjector picks the projector of the model's folder`. `downloads.test.ts`: `download posts the repo,
      revision and keys and adds the items`, `a download, download-progress or download-deleted message updates the
      store`, `a Hub error is told by its tag: HfGated, HfNotFound`, `queueProgress sums the finished files and the
      live bytes`.
- [ ] **Step 2: Implement.** Move the stores to `call`, the errors read by `_tag` (`RepoView`'s two codes become
      `HfGated`/`HfNotFound`); `ModelDetailDialog` reads `api.models.info`; bring back `ModelPicker` in the profile
      form (model and projector) and "create from model" (`/profiles?new=1&model=<path>`: the name from `stem`, the
      model and cwd placed from the path, the matching projector) per the `From E2:` line; put `/models` in `PORTED`
      and out of `MILESTONE_BY_PATH`. `features/tuning/ModelCard.tsx`, `features/system/ChecksCard.tsx` and
      `features/bench/BenchForm.tsx` stay as they are (E7, E8) as long as they compile; if one does not, the smallest
      change that keeps it compiling, recorded.
- [ ] **Step 3:** `pnpm check`, the web tests, `pnpm build`; the golden's modulepreload list re-recorded and read.
- [ ] **Step 4: Look at the page.** The build on a scratch data folder, `HOME` a scratch folder with `models/` holding
      two `writeGguf` models and a split one, a free port, the fake Hub (`node app/server/testing/hub.ts --port <n>`)
      through `HF_ENDPOINT`, Chromium (Playwright, `deviceScaleFactor: 1`): the list and a model's detail, usage and
      deletion with its profiles, a search, a repository's variants, a download that progresses then completes, a
      cancel, a retry, a clear, the model picker of a new profile and "create from model"; no console error.
      Screenshots in the session's scratchpad; every process stopped at the end.
- [ ] **Step 5:** the gates. Commit `feat(web): Bring the Models page and the downloads back`.

### Task 10: Close the milestone

**Files:**

- Modify: `docs/superpowers/poc-effect/behaviours.md`, `test-inventory.json`, `defects.md`, `conventions.md`,
  `CLAUDE.md` (only a rule a contributor needs that changed)
- Delete: `app/server-legacy/lib/hf/`, `lib/db/downloads.ts`, `lib/models/access.ts`, `lib/models/delete.ts`,
  `lib/models/gguf.test.ts`, `lib/models/scan.test.ts`, `lib/models/routes.test.ts`, `routes/api/models/`,
  `routes/api/hf/`, `routes/api/downloads/`
- Create: `docs/superpowers/poc-effect/e6.json`

- [ ] **Step 1: Behaviours.** Section E6: every line ticked with its proof (test file and name, or contract case), in
      the format of E1 to E5; a changed line says how it behaves now (the calls of this plan); every "Not covered by a
      test" line ticked with the test this plan added: search 400 → `api/models.test.ts` and `hf/http.test.ts`; info's
      400, 404, 422 and outside `relPath` → `models/http.test.ts`; usage's 400 → `models/http.test.ts`; repo's success
      and 400 → `hf/http.test.ts`; a valid download request → `downloads/http.test.ts`; delete's branching and retry's
      202 → `downloads/http.test.ts`; an enqueue with every file on disk → `Downloads.test.ts`; remove's `active` 409 →
      not ported (decided), retry's `not-finished` → `Downloads.test.ts`; a failed deletion on cancel →
      `Downloads.test.ts`; the stall, the redirects, 416/206/larger `.part`/longer body, 408/429/5xx, the budget reset,
      ENOSPC and `download-failed`, the log lines, the throttle and `bps` and `retryAt` → `transfer.test.ts` (the
      escaped error and its log → `Downloads.test.ts`); the real free-space check → `freeSpace.test.ts` and
      `Downloads.test.ts`; the WebSocket mapping → `downloads/http.test.ts`; the Hub client's timeout, abort,
      `x-error-message`, whoami not cached, `limit=30` and `expand[]` → `HfClient.test.ts`; the scan's symlinks,
      unreadable folders, `missing shard`, pruning → `scan.test.ts`; a model blocked by a download, a symlinked model →
      `models/http.test.ts` (the sweep's half moved to E7); the proxy's boot wiring → decided (the agents of `HfHttp`,
      `HfHttp.test.ts`); the dev reload resuming a download → decided: a reload rebuilds the whole layer (E1's
      restart), proven by `after a restart, the next queue resumes the item from its .part` and the lifecycle test, no
      `dev.test.ts` case. The startup lines: `useEnvProxy` → the agents (decided); the order of `dispose()` → the
      shutdown step (`Downloads.test.ts`, lifecycle); the caches lost at start → `the cache keeps the last 8 models
      only` and the repositories' tests. The `From E2:` and `From E3:` lines ticked (Task 9, Task 2). Add to the E7
      section: `From E6: the model deletion's check of a benchmark in progress and of a running sweep (the 409 "A
      benchmark in progress uses it", and blocked in the usage) comes back with the bench`.
- [ ] **Step 2: Tests.** The sixty-nine `E6` entries of `test-inventory.json` get a status (throwaway script in the
      scratchpad, never regenerated): `ported` with its new place for the entries of `downloader.test.ts` (→
      `downloads/Downloads.test.ts` or `downloads/transfer.test.ts`), `hf.test.ts` (→ `hf/token.test.ts`,
      `hf/paths.test.ts`, `hf/variants.test.ts`, `hf/HfClient.test.ts`), `gguf.test.ts` (→ `models/gguf.test.ts`,
      `models/sizes.test.ts`), `scan.test.ts` (→ `models/scan.test.ts`), the shared `hf.test.ts` and `models.test.ts`
      (same place); `rewritten` with its new place for the five of `routes.test.ts` (→ `models/http.test.ts`, the
      fifth renamed), the four `downloadFetch` tests and the two `useEnvProxy` tests (→ `hf/HfHttp.test.ts`) and the
      two `fileRange` tests (→ `downloads/transfer.test.ts`, `the verifying re-read hashes exactly the .part, in 1 MiB
      chunks`); `dropped` with a reason only where no rewrite exists (expected: none). The script checks that every
      E6 entry has a status and prints the count by status.
- [ ] **Step 3: Defects and deviations.** `defects.md` section E6: `/api/models/info` unconfined → `design choice`
      (Calls); the two 409s of a race → `confirmed`, `fixed in E6` (one step under the lock, not ported); files before
      profiles → `design choice`; no test posts a valid download → `confirmed`, `fixed in E6` (`downloads/http.test.ts`).
      Under "Changed by the Effect server", one line per call of this plan (the proxy on the agents; the unreachable
      and timeout messages; the stamps re-read once; LRU; the query refusals as `RequestInvalid`; a bad download id as
      the unknown route; the retry loop; the two directives; the benchmark check until E7; `llamaFetch.ts` kept) and
      per deviation found while porting.
- [ ] **Step 4: Conventions.** From the code as it is: an outside service with its own HTTP client (`HfHttp` next to
      `LlamaHttp`: the proxy on the agents, the offline switch, the caller bounds its wait); a queue in a layer's scope
      (one fiber, a semaphore for check-and-create, a shutdown step that keeps the work for the next start); the two
      new directives and why (the directive rule lists three `nodeBuiltinImport:off` lines); `Cache.makeWith` for a
      stamped cache; `FileSystem` errno through `cause.code`. `CLAUDE.md`: the `poc/effect` note says Hub requests go
      through `HfHttp` (`app/server/hf/HfHttp.ts`), `downloadFetch` remains the E7 reference only, and
      `LLAMA_WEBUI_TEST_OFFLINE=1` is read by `HfHttp.layer`.
- [ ] **Step 5: Legacy files.** `git rm -r` the files listed above; keep `lib/llamaFetch.ts` and its test (E7),
      `lib/models/{gguf,scan,sizes,gguf.fixture}.ts` and `lib/db/modelCache.ts` (E7, E8: `setup.get.ts`, `tuning/*`,
      `testing/seed.ts`, the legacy contract), `lib/proc.ts` and its test (`tuning/disk.ts`), `lib/env.ts` and its
      test, `lib/boot.ts`, `lib/deps.ts`, `lib/context.ts`; check with `grep -rn` that nothing kept for a later
      milestone imports a deleted file other than `lib/deps.ts`, `lib/boot.ts` and the legacy `contract/` (as after E5).
- [ ] **Step 6:** `pnpm lint && pnpm check && pnpm test && pnpm build && node scripts/smoke.ts`,
      `pnpm --filter llamacpp-js test`, `pnpm check 2>&1 | grep -c 'effect('` (0), `pgrep -f fake-llama-server`
      (nothing), `pgrep -f testing/hub.ts` (nothing). Commit `chore(poc): Close E6, the models`.
- [ ] **Step 7:** `node scripts/poc/measure.ts --out docs/superpowers/poc-effect/e6.json --skip-durations` (the times
      taken by hand in the report, as E5), format, commit `chore(poc): Measure E6`.
- [ ] **Step 8: Report.** Per task what was built; every deviation and why; every place the plan was wrong; every
      behaviour dropped, changed or moved; directives and override entries (expected: `hash.ts` and `freeSpace.ts`;
      `models.ts` and `hf.ts` in the third override); what Task 9 Step 4 showed; `e6.json` next to `e5.json`; anything
      left undone.
