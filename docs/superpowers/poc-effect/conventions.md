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
  package, except `api/**`, `settings.ts` and `ws.ts`, which follow the server's rules (a milestone adds the modules it
  moves to Schema). Nothing else is added to the overrides.
- Two directives are allowed, each with its reason on the line:
  `// @effect-diagnostics-next-line nodeBuiltinImport:off <reason>` (one today: `node:http` in
  `app/server/http/HttpLive.ts`, `NodeHttpServer.layer` takes its factory) and `processEnv:off` at the one write of
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
  the body encoded by that schema (a `Profile` through `ProfileInput` loses its id, source and dates), 2-space JSON, a
  trailing newline, `content-disposition: attachment; filename*=UTF-8''<percent-encoded>` (`exportOne` of
  `profiles/http.ts`).
- A 204: an endpoint with no `success` (`remove` of `ProfilesApi`), whose handler succeeds with `void`.

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
- **A /ws message**: a `Schema.Struct({ type: Schema.Literal('…'), payload })` in `packages/webui-shared/src/ws.ts`,
  added to the `WsMessage` union, sent with `WsHub.publish`.
- **A contract case**: an `add(kind, name, req)` in `cases()` of `app/server/contract/cases.ts` for each endpoint of the
  group (the coverage test fails without one: `covers(endpoint, req)` matches a `:param` with any non-empty segment),
  a `violation`, `body` or `guard` case for what the edge refuses and a `refusal` case for what the domain refuses
  (a 404 of a missing row, a 409), then `UPDATE_GOLDEN=1` and read the diff of `golden.json`. A case that needs a
  setting sets it with a `PATCH /api/settings` case just before it; a file or a program it needs comes through the
  context of `cases()` (`Binaries`: the fake llama-server of `testdata/fake/`, a path in the run's temporary folder),
  and its paths are recorded as `<repo>`, `<tmp>` or `<home>`, never as they are on this machine.
- **A web page that returns**: its import in `PORTED` of `app/src/app/router.tsx`, its entry out of
  `MILESTONE_BY_PATH` in `app/src/app/routes.ts`, its tests out of the `"exclude"` of `app/tsconfig.json`. Its calls go
  through `call((api) => api.<group>.<endpoint>(…))`; an error is told by its `_tag` (`fieldErrors` of
  `features/profiles/errors.ts` puts a `RequestInvalid`'s issues on their fields). A part that needs a store of a
  later milestone (`@/lib/server` until E3, `@/lib/models` until E6) is removed, not stubbed, and recorded as a
  `From E<n>:` line in the section of that milestone in `behaviours.md`; it comes back with the store.

## Tests

- Effect code is tested through `layer(L)('Name', (it) => { it.effect(…) })` of `@effect/vitest`
  (`settings/http.test.ts`): the test stays an effect (no `Effect.runPromise` in a test body), the layer's finalizers
  run after the block, and `it.effect` runs on the `TestClock`. The block shares one layer: a test that needs a clean
  state builds its own (`fresh` in `settings/SettingsRepo.test.ts`). `it.live` for real time and real sockets.
- A test that stops the server with a client connected builds the server in a scope of its own and the client
  outside it (`start({ scope })` in `ws/WsHub.test.ts`), then closes that scope: the client sees the stop.
- Effect's `HashSet` and `Equal` compare structurally: two pending `Deferred`s are equal and a `HashSet` of them has
  one member. Keep identities in a native `Set` (the hub's clients, `ws/WsHub.ts`).
- Black-box suites (`lifecycle.test.ts`, `contract/`, `build.test.ts`, `dev.test.ts`) are plain Node against the build
  (`launch()` of `app/server/testing/launch.ts`) and never pick port 7860 or 7861.

## Commands

- One file: `pnpm exec vitest run <path>` (`LLAMA_WEBUI_TEST_BUILD=0` reuses `app/.output` after a `pnpm build`).
- The golden record: `UPDATE_GOLDEN=1 pnpm exec vitest run app/server/contract/contract.test.ts`, then read the diff.
- Dev: `pnpm dev` (the server under `node --watch`, restarted on a save under `server/` or `packages/`; the Effect
  DevTools are used when something listens at `LLAMA_WEBUI_DEVTOOLS_URL`, `ws://localhost:34437` by default).
- Everything: `pnpm lint && pnpm check && pnpm test`; `pnpm check 2>&1 | grep -c 'effect('` gives 0.
