# Conventions of the Effect server

The rules E2 to E8 follow, read from the code E1 left (`app/server/`, `packages/webui-shared/src/api/`). Read
`repos/effect/LLMS.md` first; this page says how this repository applies it.

## Where a domain goes

The settings domain is the example of each piece.

| Piece                                     | Where                                              | Example                                                  |
| ----------------------------------------- | -------------------------------------------------- | -------------------------------------------------------- |
| Schemas of the data (shared with the web) | `packages/webui-shared/src/<domain>.ts`            | `packages/webui-shared/src/settings.ts` (`Settings`)     |
| API group, its endpoints and their errors | `packages/webui-shared/src/api/<Domain>Api.ts`     | `api/SettingsApi.ts` (`SettingsApi`, `SettingsInvalid`)  |
| Errors shared by every group              | `packages/webui-shared/src/api/errors.ts`          | `RequestRefused`, `RouteNotFound`                        |
| The API, one `.add(Group)` per domain     | `packages/webui-shared/src/api/Api.ts`             | `Api`                                                    |
| Service (state, SQL, logic)               | `app/server/<domain>/<Name>.ts`                    | `app/server/settings/SettingsRepo.ts`                    |
| Handlers of the group                     | `app/server/<domain>/http.ts`                      | `app/server/settings/http.ts` (`SettingsHandlers`)       |
| Tests                                     | next to the file: `<Name>.test.ts`, `http.test.ts` | `settings/SettingsRepo.test.ts`, `settings/http.test.ts` |

An error an endpoint answers is a `Schema.TaggedError` with its `httpApiStatus` annotation, in the group's file, and
is exported from `packages/webui-shared/src/index.ts`. Before exporting a name from that barrel, check that no other module of it exports the
same name: two `export *` of one name fail `tsc` (TS2308), but a named export (`export { SettingsInvalid } from …`)
silently hides the member of the same name of an `export *` module (`bench.ts`, `profile.ts`…). The shared
package declares `"sideEffects": false`: the web imports `Api` from the barrel, and without it the bundler keeps
every module the barrel reaches (zod came back into the client entry, `0edb35fbc`).

## Diagnostics

The Effect language service (`tsconfig.effect.json`) is blocking, warnings included: `pnpm check` prints no
`effect(<rule>)` line. Fix what a rule reports with its own suggestion.

- The overrides relax the platform rules (Node builtins, `fetch`, timers, `JSON`, Effect's array and string helpers,
  `strictBooleanExpressions`) only for code that drives the build from outside: `**/testing/**`, `**/contract/**`,
  `lifecycle.test.ts`, `build.test.ts`, `dev.test.ts`, `runApp.test.ts`; and for the plain modules of the shared
  package, except `api/**`, `chat.ts`, `logs.ts`, `monitor.ts`, `profile.ts`, `server.ts`, `settings.ts`, `topology.ts`
  and `ws.ts`, which follow the server's rules (the third override: a milestone adds the modules it moves to Schema).
  Nothing else is added to the overrides.
- Two directives are allowed, each with its reason on the line:
  `// @effect-diagnostics-next-line nodeBuiltinImport:off <reason>` (one today: `node:http` in
  `app/server/http/HttpLive.ts`, `NodeHttpServer.layer` takes its factory; `node:ffi` is not flagged and needs none)
  and `processEnv:off` at the one write of
  `.env` into the environment (not needed: `applyDotEnv(process.env, …)` in `config/DotEnv.ts` is not flagged). A
  directive that suppresses nothing fails `tsc`.
- A Schema class takes the brand the rule asks for (`TaggedError<X, { readonly X: unique symbol }>()`) and is built
  with `X.make(…)`, never `new X(…)`.
- A service is a `Context.Service` class keyed `@llama-webui/app/server/<path>/<Name>`
  (`'@llama-webui/app/server/settings/SettingsRepo'`), with its layers as statics (`layer`, `layerWith(options)`).
- `missingPipeableSignature` on an exported function of two or more parameters: `dual` from `effect/Function` when the
  first parameter is the subject (`applyDotEnv` in `config/DotEnv.ts`, `app/server/http/Sse.ts`), else one options
  object.
- Configuration: nothing reads `Config` (or `AppConfig`) before `loadDotEnv` has run (`app/server/main.ts`: the
  default provider snapshots the environment on first use).

## Requests

- Every endpoint declares what it reads as schemas: `params` (an id is `IdParam` of
  `packages/webui-shared/src/api/params.ts`, a positive integer in decimal digits), `payload`, `query`. A handler
  never parses a body or a parameter itself.
- `Api` decodes payloads strictly (`HttpApi.PayloadParseOptions`: an unknown key is an issue, every issue reported)
  and carries the `RequestErrors` middleware (`.middleware(RequestErrors)` after the last `.add`: it reaches only the
  groups added before it). `RequestErrorsLive` (`app/server/http/RequestErrors.ts`) answers a payload, a query or a
  header that does not decode with a 400 `RequestInvalid` `{ message: "Invalid data: <first issue> (<path>)", issues }`
  (`requestInvalid` of `api/errors.ts`) and a path parameter with the 404 `RouteNotFound`; it is not logged as a
  failure. A field's message is the `message` of its check (`'cannot be empty'`), an unknown key's the
  `messageUnexpectedKey` annotation of the struct (`'unknown key'`, `ProfileInput`).
- Validation is tested over raw HTTP against the built routes (`send` in `profiles/http.test.ts`,
  `http/RequestErrors.test.ts`): the typed client encodes a payload before sending, so a bad one never leaves it. The
  web's `makeCall` (`app/src/lib/api.ts`) turns that refusal into the same `RequestInvalid`, so a page reads one shape.
- A path that ends with a slash under `/api/` or `/ws/` is a 308 to the path without it (`http/TrailingSlash.ts`),
  after the guard.

## Replies

- A file to download: the endpoint's `success` is the schema of the file (the typed client decodes it), and the
  handler returns `attachment(schema)({ filename, body })` of `app/server/http/attachment.ts`, built once per schema:
  the body encoded by that schema (a `Profile` through `ProfileExport` loses its id, source and dates), 2-space JSON, a
  trailing newline, `content-disposition: attachment; filename*=UTF-8''<percent-encoded>` (`exportOne` of
  `profiles/http.ts`).
- A reply carries what is stored, so its schema has no input rule: a check runs on encoding too, and one stored row
  that a rule now refuses would turn every reply that holds it into a 500. The rules live in the payload's schema
  (`ProfileInput`); the reply and the export have the same fields without them (`Profile`, `ProfileExport` of
  `packages/webui-shared/src/profile.ts`). A domain's HTTP test stores such a row by SQL and reads it back
  (`a stored profile the input rules now refuse…` in `profiles/http.test.ts`).
- A 204: an endpoint with no `success` (`remove` of `ProfilesApi`), whose handler succeeds with `void`.
- A reply that streams (server-sent events): the endpoint's `success` is `HttpApiSchema.StreamSse({ events })`, where
  `events` is the codec of one event as `{ event, data }` (`ChatSseEvent` of `api/ChatApi.ts`: `event:` the type,
  `data:` the JSON of a `ChatEvent`), so the typed client decodes the body into a `Stream` of the domain's events. The
  handler is `handle`, never `handleRaw` (which does not decode the payload: `HttpApiBuilder.ts:968`), and returns
  `sseResponse(Stream.mapEffect(events, Schema.encodeEffect(Codec)))` of `app/server/http/Sse.ts`: the headers of the
  Nitro stream (`cache-control`, `x-accel-buffering: no`, `connection: close`), a `: ping` every 15 s, a client that
  goes away interrupts the stream (`replyResponse` of `chat/http.ts`). A returned `HttpServerResponse` passes through
  the endpoint's encoder as it is; a declared error still answers its status. An endpoint that streams or answers
  nothing has `success: [Stream, HttpApiSchema.NoContent]`: the handler returns `void` for the 204 (`follow`), the
  client reads `undefined`.
- The web calls a streaming endpoint with `callStream((api) => api.<group>.<endpoint>(…), onEvent, { signal })` of
  `app/src/lib/api.ts`: each decoded event in order, resolved at the end of the stream; rejected with the endpoint's
  tagged error, `ApiUnreachable` (no answer, or a body that breaks off: `HttpClientError`) or `ApiReplyInvalid` (an
  event that does not decode: `SchemaError`, `SseError`, `Retry`; logged); an abort of `signal`, before the response
  or during the stream, ends it without an error and aborts the request. The SSE wire is tested with the typed client
  over HTTP (`the typed client decodes a reply…` in `chat/http.test.ts`), the headers over raw HTTP.

## Programs and the home folder

- A path a person wrote goes through `expandHome` of `app/server/config/Home.ts` (`~` and `~/…`, `HOME` read with
  `Config`, else the system's home). Effect has no home directory of its own: the module imports `homedir` of `node:os`.
- A program runs through `effect/process`: `ChildProcess.make(cmd, args, { stdin: 'ignore', stderr: 'ignore',
  forceKillAfter })` and `ChildProcessSpawner.spawn` in an `Effect.scoped`; the scope's end kills the process group
  (`SIGTERM`, then `SIGKILL` after `forceKillAfter`). Read its output and its exit code together
  (`Effect.all([Stream.mkString(Stream.decodeText(out)), handle.exitCode], { concurrency: 2 })`), bound the output
  (`Stream.mapEffect` counting bytes), treat a non-zero code as a failure, and put the whole run under
  `Effect.timeout`: a timeout interrupts the run, the scope closes and the program is killed (`flags/Flags.ts`). A
  one-shot command whose output is not read: `spawner.exitCode(command)`. Tests write their programs as shell
  scripts in a scoped temporary folder (`flags/Flags.test.ts`).
- A result per key computed once: `Cache.makeWith(lookup, { capacity, timeToLive })`, a failure kept for
  `Duration.zero` so the next call runs it again; concurrent gets of one key share the lookup.

## A long-lived process and the state around it

The model is `app/server/supervisor/Supervisor.ts`.

- **A long-lived process** goes through `followProgram` of `app/server/process/followed.ts`, never a hand-written
  spawn, with the layer's scope of operations as its `parent` (forked `'parallel'` when it holds several programs, so
  that at the end they stop at once: `ops` of `collectors/nvidia.ts`, `programs` of `collectors/Collectors.ts`):
  - `followProgram({ command, parent, name, onSpawn?, read, onExit? })` spawns `command` in a scope of its own forked
    from `parent` (`Followed.scope`, where the caller forks what goes next to the readers, a health poll), runs
    `onSpawn` (the state names the process, before any output is read), forks `read` into that scope, and watches the
    exit from a fiber of `parent`: it joins `read` (1 s at most, `DRAIN_TIMEOUT`: closing at once loses the last
    lines), runs `onExit(ended, program)` with the code or the failure of `exitCode`, then closes the program's scope,
    uninterruptibly; `ended` completes then. A spawn that fails fails with the spawner's error, nothing left behind.
  - `Followed.stop` closes the program's scope (it kills the program), and every close of that scope, by `stop`, by
    the exit or by the end of `parent`, waits `CLOSE_BOUND` (1 s) at most: the spawner's release waits for the exit
    without a limit, and a program in uninterruptible sleep in a driver call does not exit on SIGKILL until the call
    returns. Past the bound `closeWithin` logs `<name> did not end 1s after its stop` and lets the close go on alone.
    A program's own scope outside `followProgram` (a one-shot query that may hang: `queryApps` of
    `collectors/nvidia.ts`) is closed with `closeWithin` too.
  - `FORCE_KILL_AFTER` (1 s) is the `forceKillAfter` of a program asked to stop with SIGTERM; a program stuck in a
    native call is spawned with `killSignal: 'SIGKILL'`. Models: `supervisor/Supervisor.ts` (llama-server),
    `collectors/nvidia.ts`, `collectors/membw.ts`, `collectors/nvml/Nvml.ts`.
- `handle.exitCode` fails when a signal ended the process; read the signal from the message of its cause
  (`/signal: '([A-Z0-9]+)'/`). A stop in two signals:
  `handle.kill({ killSignal: 'SIGTERM' }).pipe(Effect.interruptible, Effect.timeoutOption(timeout))`, then
  `kill({ killSignal: 'SIGKILL' })` on none. `Effect.interruptible` lets the timeout end the wait, in a finalizer
  too. `forceKillAfter` of `ChildProcess.make` is the backstop of a scope closed on a live process.
- **An operation that outlives its request** (a start, a stop) runs in a fiber of the layer's scope
  (`Effect.forkIn(operation, ops)`), and the caller joins it inside `Effect.uninterruptibleMask` with `restore`: a
  caller that goes away stops waiting, and the operation runs to its end. For one at a time, use `Semaphore.make(1)`:
  `Semaphore.takeIfAvailable` (released by `Effect.ensuring`) for an operation that is refused while another runs,
  `withPermits(1)` for one that waits.
- **State shared by several fibers** is one `SynchronizedRef` with one function that changes it. In `change(f)`, `f`
  sees what is held and answers the next value, or none. The new state is published inside
  `SynchronizedRef.modifyEffect`, so the messages leave in the order of the changes. `f` checks that the state is
  still the one its caller saw (the same process, still `starting`), so a late answer never undoes a newer state.
- **State of several runs** (one reply per conversation: `app/server/chat/ChatRuns.ts`): one
  `SynchronizedRef<ReadonlyMap<key, Run>>`, and the start of a run is one step under its lock
  (`SynchronizedRef.modifyEffect(runs, …)`, made `Effect.uninterruptible`): the checks (the row exists, no run for the
  key, a server answers), the writes that precede the run, the fork of the run (`Effect.forkIn(run, scope)`, the
  layer's scope) and its registration. Two requests at once then give one run and one refusal; a check then a later
  `set` does not (the test that proves it delays a step of the start: synchronous SQLite never interleaves). A read
  that must see a start in flight takes the lock too (`SynchronizedRef.modify(runs, (now) => [now, now])`), then waits
  outside it: the run's end takes the lock to leave the map, removing itself by identity. Each run holds its own
  `SynchronizedRef` (what it wrote) and a `PubSub` of its events, published inside the change of that ref, so a
  subscriber that takes the replay and subscribes in one `modifyEffect` misses nothing and gets nothing twice. A stop
  completes a `Deferred` the run's consumption races (`Effect.raceFirst`): leaving the stream aborts its request. The
  run's `Effect.onExit` takes it out of the map, logs a failure that is not an interruption and shuts its `PubSub`
  down when it ended unsaved, so its clients' streams end.
- **`LlamaHttp`** (`app/server/llama/LlamaHttp.ts`) is the client of every request to a llama-server, under its own
  tag (`Context.Service<LlamaHttp, HttpClient.HttpClient>`). It is not `HttpClient.HttpClient`: in the HTTP tests that
  tag is the test server's client, and Hugging Face gets its own client (E6, with the proxy).
  - It is `NodeHttpClient.layerNodeHttpOptions({ keepAlive: false })`: no proxy, no limit on the headers or on the
    body, and a socket of its own per request.
  - It is wrapped in `HttpClient.withScope`, so each request belongs to its caller's scope. A probe is therefore
    `client.get(url).pipe(Effect.map((r) => r.status), Effect.scoped)` under its own timeout, and leaving a streamed
    body aborts its request.
  - The probes and `/props` are in `app/server/llama/probes.ts`; `/proc` is read through `FileSystem`
    (`llama/procScan.ts`).
- **The tiers of `Services`** (`app/server/App.ts`): each `Layer.provideMerge` is a tier, built after the ones below
  it and undone before them.
  - From the bottom: the database, `AppInfo`, the hub and the repositories (`ConversationsRepo` with them), the ring,
    `LlamaHttp` and `PciIds`, `Flags`, the supervisor, the monitor, the placement and the chat's `ChatRuns`, the watch.
  - The watch ends first (no look while the rest stops). The monitor and `ChatRuns` end before the supervisor, the
    collectors' programs with the monitor, the replies left by the shutdown step interrupted with `ChatRuns`. The
    supervisor stops llama-server while the ring and the hub it writes to are still up. The database closes last.
  - All of it runs after the shutdown steps and after the HTTP server closed (`Shutdown.layerRunner`, E1).
  - A service's own end goes in its layer (`Effect.addFinalizer`, `Effect.acquireRelease`). It is a shutdown step
    only when it must run while the clients are still connected.
- **A scoped background loop** (`app/server/supervisor/ExternalWatch.ts`) is
  `Layer.effectDiscard(check.pipe(Effect.repeat(Schedule.spaced(interval)), Effect.forkScoped))`:
  - its first run starts at once without holding the start of the app;
  - each next run starts `interval` after the previous one ended, so one runs at a time;
  - the end of the layer interrupts it;
  - its interval is an option of `layerWith`.

## Following a service's changes

- A service whose state others follow exposes its changes as a subscription: `changes` of `Supervisor`, `batches`
  of `LogRing`, each `Effect.map(PubSub.subscribe(pubsub), Stream.fromSubscription)`, an
  `Effect<Stream<A>, never, Scope>`. The service publishes to its `PubSub` in the step that changes its state (inside
  the `SynchronizedRef.modifyEffect` of `change`, after the `/ws` message), so the subscribers get the changes in
  their order.
- A follower subscribes first, then reads the current value, then follows the stream in a fiber of its layer
  (`Stream.runForEach(…)`, `Effect.forkScoped`): nothing that changes between the read and the subscription is missed
  (`app/server/monitor/Placement.ts`, which merges both streams into one fiber).

## A pure step with its I/O around it

- What a loop decides is a pure function of what it read: `beginTick` and `endTick` of `app/server/monitor/tick.ts`
  (the memory of the previous tick and the readings in, the next memory, the history's points and the snapshot out),
  `onSample`, `onConfigure` and `isFresh` of `app/server/collectors/nvml/Nvml.ts` (the reader's state and a message
  or the time in, the next state out), `procVramOf` of `app/server/collectors/gpu.ts` (the cards and their processes
  in, the VRAM of a pid per card out). The service around it reads (in parallel, each read with its
  fallback), calls the step, and stores and publishes the result (`Monitor.tick`).
- The step is tested as a plain function (`describe`/`it`, no layer, the time passed in): every rule of the tick is
  asserted in a few milliseconds, without timers or programs (`monitor/tick.test.ts`). The service's test on real
  time then asserts only what the loop adds: the publishing, the interval, a tick that dies, a reader that never
  answers (`monitor/Monitor.test.ts`).

## Finite numbers

- Every number a schema of the shared package sends is `Schema.Finite` or `Schema.Int`, never `Schema.Number`
  (`packages/webui-shared/src/monitor.ts`, `topology.ts`): a reply carries no NaN or Infinity. `Int` is for what is
  integral by construction (times in ms, counts, ticks, PCIe gen and width); a measure or a gauge (an average such as
  `busySlots`) is `Finite`.
- The hub drops a message that does not encode, silently: what a reading gives is made finite before it reaches a
  schema (`app/server/monitor/finite.ts`: `null` where the field allows it, else `0`; an `Int` field takes the integral
  part). The history keeps the raw values, and its dump writes a value that is not finite as `null`. A test feeds the
  step non-finite readings and encodes its result (`tick.test.ts`: a tick fed non-finite readings still encodes as a
  Snapshot).

## A child program spoken to in NDJSON

The model is the NVML sampler, `app/server/collectors/nvml/`.

- The program is an Effect program of its own (`worker.ts`: `NodeRuntime.runMain(program.pipe(Effect.provide(
  NodeServices.layer)))`), run as is by Node in development (imports with `.ts`) and bundled to
  `.output/server/nvml-worker.mjs` by `app/build/server.ts`, next to `index.mjs`: the module that starts it finds it
  next to itself (`workerPath(import.meta.url)`: `worker.ts` next to a `.ts` module, `nvml-worker.mjs` otherwise), and
  `build.test.ts` checks that it sits there and starts from the bundle.
- Both sides decode the lines with one schema module (`protocol.ts`: `ToSampler`, `FromSampler`), through
  `Ndjson.decodeSchema(schema)({ ignoreEmptyLines: true })` and `Ndjson.encodeSchemaString(schema)()` in
  `Stream.pipeThroughChannel`. The program reads `Stdio.stdin` and writes `stdio.stdout()`; the server feeds
  `handle.stdin` from a `Queue` (ended to close the program's stdin) and reads `handle.stdout`.
- The end of its stdin is its exit: the program sends what it queued, then its scope stops the rest, exit 0. A server
  killed with SIGKILL closes the pipe all the same, so the program never outlives it. The server spawns it with
  `killSignal: 'SIGKILL'` (a program stuck in a native call is not asked to stop) through `followProgram`, and
  abandons it (killed, its readings cleared) on an `error`, an exit or a line that is not a message.
- `node:ffi` is imported by `symbols.ts` with no directive: the `nodeBuiltinImport` rule does not flag it (an unused
  directive would fail `tsc`). It is run with `--disable-warning=ExperimentalWarning`.
- Tests fake the program with a Node script (`app/server/testing/fixtures/fakeNvml.ts <behaviour> <dir>`, which
  records its pid and what it received) and run the real `worker.ts` where the machine allows. A fake that stands for a
  long-lived program is one process (`exec`, or Node): a shell loop leaves zombie children that this container's init
  reaps late, and the spawner then waits out `forceKillAfter` (`lifecycle.test.ts`, its fake nvidia-smi).

## SQL

- Through `SqlClient` (`@effect/sql-sqlite-node`), opened by `app/server/db/Db.ts`; migrations in
  `app/server/db/migrations.ts`, one record entry each, a table rebuild through `rebuild({ version, sqls })`.
- `node:sqlite` binds a JS number as REAL unless it is integral and the column is INTEGER: a number fed to a JSON
  function or an untyped column is written `CAST(? AS INTEGER)` in the SQL. The client is not wrapped to change this.
- A failed statement is a `SqlError` whose `reason` says what failed: `reason._tag === 'ConstraintError'` for a
  constraint, the SQLite text in `reason.cause` (`db/Db.test.ts`, `http/Address.ts` reads `reason.cause` the same way).

## Adding

- **A group's handlers**: `HttpApiBuilder.group(Api, '<group>', Effect.fn(function* (handlers) { … }))` in
  `<domain>/http.ts`, then into the `Layer.mergeAll(…)` of `ApiRoutes` in `app/server/http/HttpLive.ts`.
- **A service layer**: into `Services` of `app/server/App.ts` (and `ServicesTest` of `app/server/testing/services.ts`,
  on `Db.layerAt(':memory:')`). Its dependencies come from the `provideMerge` chain below it.
- **A shutdown step** (a reply saved "stopped", a run "interrupted", a last message): `yield* shutdown.before(step)`
  while the service is built (`yield* Shutdown`). Steps run when the app stops, last registered first, before the HTTP
  server stops serving; a step that fails is logged and the next ones still run. The hub's own flush step is
  registered when the hub is built, so it runs after the steps of the services built on it. A wait in a step is made
  `Effect.interruptible` before `Effect.timeout`: a finalizer runs uninterruptibly and the timeout could not end it.
  A step that saves what a process is doing (a reply of llama-server) belongs to a service of a tier above the
  supervisor, so it runs while the process still answers, and the service's layer ends before the supervisor stops it.
  The step saves first, then stops the work, and the work writes nothing once it finds its result saved (`final` of
  a run in `ChatRuns`, written under the run's own lock): a work stopped first would save its own result and race the
  step. It publishes the last event itself (`done`), so the clients' streams end before the HTTP server closes.
- **A /ws message**: a `Schema.Struct({ type: Schema.Literal('…'), payload })` in `packages/webui-shared/src/ws.ts`,
  added to the `WsMessage` union, sent with `WsHub.publish`.
- **A contract case**: an `add(kind, name, req)` in `cases()` of `app/server/contract/cases.ts` for each endpoint of the
  group (the coverage test fails without one: `covers(endpoint, req)` matches a `:param` with any non-empty segment),
  a `violation`, `body` or `guard` case for what the edge refuses and a `refusal` case for what the domain refuses
  (a 404 of a missing row, a 409), then `UPDATE_GOLDEN=1` and read the diff of `golden.json`. A case that needs a
  setting sets it with a `PATCH /api/settings` case just before it; a file or a program it needs comes through the
  context of `cases()` (`Binaries`: the fake llama-server of `testdata/fake/`, a path in the run's temporary folder),
  and its paths are recorded as `<repo>`, `<tmp>` or `<home>`, never as they are on this machine. A reply that depends
  on the machine (its CPU, its PCI devices: `GET /api/system/info`, `GET /api/topology`) is added with
  `{ machine: true }`: its success records the sorted names of its fields (`fields`), not its body; its values are
  asserted by the domain's HTTP test. The suite runs on the stub monitor (`LLAMA_WEBUI_TEST_MONITOR=stub`, set by its
  `launch()`), so no snapshot depends on the machine.
- **A web page that returns**: its import in `PORTED` of `app/src/app/router.tsx`, its entry out of
  `MILESTONE_BY_PATH` in `app/src/app/routes.ts`, its tests out of the `"exclude"` of `app/tsconfig.json`. Its calls go
  through `call((api) => api.<group>.<endpoint>(…))` (a stream through `callStream`, see Replies); an error is told
  by its `_tag` (`fieldErrors` of `features/profiles/errors.ts` puts a `RequestInvalid`'s issues on their fields). A
  part that needs a store of a later milestone (`@/lib/server` until E3, `@/lib/models` until E6) is removed, not
  stubbed, and recorded as a `From E<n>:` line in the section of that milestone in `behaviours.md`; it comes back with
  the store. A pure function of such a store's module moves, unchanged, to a module the page can import (`stem` of
  `app/src/lib/stem.ts`, E5).

## Tests

- Effect code is tested through `layer(L)('Name', (it) => { it.effect(…) })` of `@effect/vitest`
  (`settings/http.test.ts`): the test stays an effect (no `Effect.runPromise` in a test body), the layer's finalizers
  run after the block, and `it.effect` runs on the `TestClock`. The block shares one layer: a test that needs a clean
  state builds its own (`fresh` in `settings/SettingsRepo.test.ts`). `it.live` for real time and real sockets.
- A test that stops the server with a client connected builds the server in a scope of its own and the client
  outside it (`start({ scope })` in `ws/WsHub.test.ts`), then closes that scope: the client sees the stop.
- Effect's `HashSet` and `Equal` compare structurally: two pending `Deferred`s are equal and a `HashSet` of them has
  one member. Keep identities in a native `Set` (the hub's clients, `ws/WsHub.ts`).
- **Tests on real time** (processes, sockets, schedules): `layer(L, { excludeTestServices: true })('…', (it) => …)`.
  Without it, `it.effect` runs on the `TestClock`, and a poll, a schedule or a timeout never moves. Inside a shared
  layer, `it.live` does not exist.
  - `buildPerTest: true` gives each test a fresh layer.
  - The durations of a service are options of its `layerWith` (`Supervisor.layerWith({ killTimeout, healthPoll })`,
    `ExternalWatch.layerWith({ interval })`), shortened in `ServicesTest`.
  - `app/server/testing/llama.ts` holds the fake llama-server (`FAKE`, `testdata/fake/`), `freePort`, `httpStub`, a
    fake started outside the supervisor (`fakeOutside`), the start of the fake through the API of a running build
    (`startFakeThrough`, with the fake's `FAKE_*` environment), and `chatStub`, a llama-server on loopback whose chat
    reply the test writes chunk by chunk (`chunk`, `done`, `end` without `[DONE]`, `cut`), given to
    `ChatRuns.layerWith` as its `target` or found as an external server (`supervisor.detectExternal`).
  - A test that starts a process asserts that it is dead at the end.
  - A program whose exit never comes back once killed (stuck in a driver call) is faked by `stuckRelease` of
    `app/server/testing/stuckRelease.ts`: the platform's spawner, whose release waits, once the process is killed
    and gone, until the test's `unstick` (`process/followed.test.ts`, `monitor/Monitor.test.ts`). A real unkillable
    process cannot be made here.
  - Every profile of a test sets its own free port, and every test of the watch sets the `port` setting to a free
    one: never 8080, where a real llama-server may listen.
  - The data folder of a build or of `vite dev` that a test runs is seeded with a free `port` setting before the start
    (`seedWatchPort` of `app/server/testing/seed.ts`).
- Black-box suites (`lifecycle.test.ts`, `contract/`, `build.test.ts`, `dev.test.ts`) are plain Node against the build
  (`launch()` of `app/server/testing/launch.ts`) and never pick port 7860 or 7861.

## Commands

- One file: `pnpm exec vitest run <path>` (`LLAMA_WEBUI_TEST_BUILD=0` reuses `app/.output` after a `pnpm build`).
- The golden record: `UPDATE_GOLDEN=1 pnpm exec vitest run app/server/contract/contract.test.ts`, then read the diff.
- Dev: `pnpm dev` (the server under `node --watch`, restarted on a save under `server/` or `packages/`; the Effect
  DevTools are used when something listens at `LLAMA_WEBUI_DEVTOOLS_URL`, `ws://localhost:34437` by default).
- Everything: `pnpm lint && pnpm check && pnpm test`; `pnpm check 2>&1 | grep -c 'effect('` gives 0.
