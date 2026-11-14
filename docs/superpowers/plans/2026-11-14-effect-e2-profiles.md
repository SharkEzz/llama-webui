# Effect POC, E2: Profiles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring the profiles back on the Effect server: the twelve endpoints of the domain (CRUD, duplicate, import and
export, the llama-tui import, the flag catalogue), the Profiles page of the web, and the rule the user set for a
trailing slash. E2 also sets how every later domain validates a request.

**Architecture:** The shared package defines the profile schemas (Effect Schema, zod gone from `profile.ts`), the
`profiles` and `flags` groups of the `HttpApi`, and one API-wide middleware that turns a request that does not decode
into a typed error. The server adds one folder per concern (`app/server/profiles/`, `app/server/flags/`): a repository
service on SQLite, a reader of the llama-tui config, a cached flag catalogue read through Effect's child processes, and
the handlers. The web's Profiles page calls the derived client; its parts that need the supervisor (E3) or the models
(E6) wait.

**Tech Stack:** Effect 4.1.4 (`effect`, `effect/http`, `effect/http-api`, `effect/sql`, `effect/process`),
`@effect/platform-node`, `@effect/sql-sqlite-node`, `@effect/vitest`, Node ≥ 26.13, Vitest 5, Biome.

**Spec:** `docs/superpowers/specs/2026-11-14-effect-server-design.md`. Acceptance list:
`docs/superpowers/poc-effect/behaviours.md`, section E2. Rules of the new server:
`docs/superpowers/poc-effect/conventions.md` (read it before writing code).

**Calls made by this plan** (the author's unless marked; each is recorded by Task 9):

- **User:** a path that ends with a slash is redirected to the same URL without it. Author's part: status 308 (the
  method and the body are kept), for paths under `/api/` and `/ws/` only (the UI's paths belong to the client router),
  query string kept, after the guard.
- Requests are validated by their schema at the edge, for every domain from now on: a payload or a query that does not
  decode is a 400 `RequestInvalid` with `issues`, a path parameter that does not decode is the 404 `RouteNotFound`.
  Consequences, all deviations from the Nitro server: on `PUT /api/profiles/:id` an invalid body is a 400 even when the
  profile does not exist (was 404 first); an id that is not a positive integer answers `Unknown route` (was
  `Profile not found`); a body that is not JSON answers `Invalid data: Expected a valid JSON body` (was `Invalid JSON`;
  E1 answered a bare 400); an unknown key answers `unknown key` (was zod's wording); the `code` of an error
  (`name-taken`) is its `_tag` (`ProfileNameTaken`).
- The 409 `This profile belongs to the running server: stop it first` of a deletion returns with the supervisor (E3).
  No stand-in service is written for it now.
- The Profiles page comes back without what needs an unported store: the running marker, "Start this profile", the
  restart dialog and the preselection of the running profile (E3); the model picker and "create from model" (E6). Until
  E6 the model and the projector are plain path inputs.
- The three reported defects of the domain (`defects.md`) are not defects: a deletion answers 409 before 404 only for
  the running profile, which exists; the schema is strict and has no maximum for a name by design; the flag catalogue
  is read once per binary path per run by design. All three are reproduced.
- Legacy files: E2 deletes its own (listed in Task 9) and the ones E1 left behind; `lib/profiles/remove.ts` stays
  until E3 (it holds the 409 above).
- **User (during execution):** the llama-tui import is not ported: its two endpoints, the `LlamaTui` service, the
  `llamaTuiImportDismissed` setting and the import banner are dropped; Task 5 keeps `Home` only.

## Global Constraints

- Branch `poc/effect`, after E1 (`chore(poc): Measure E1 on its last commit`). No push, no pull request.
- **Before writing any Effect code, read `repos/effect/LLMS.md` completely**, then
  `docs/superpowers/poc-effect/conventions.md`, then the reference files of the task. `repos/effect` is the installed
  version (4.1.4): read it, not `node_modules`, and never edit it. Its modules are under
  `repos/effect/packages/effect/src/` (`http/`, `http-api/`, `process/`, `sql/`), the Node platform under
  `repos/effect/packages/platform/node/src/`.
- **Effect diagnostics are blocking:** `pnpm check 2>&1 | grep -c 'effect('` prints `0`, warnings included. Fix what a
  rule reports with its own suggestion. No new `@effect-diagnostics` directive and no new override entry, except the
  two this plan names: `packages/webui-shared/src/profile.ts` joins the third override of `tsconfig.effect.json`
  (Task 3), and `app/server/config/Home.ts` may carry `// @effect-diagnostics-next-line nodeBuiltinImport:off` with
  its reason on the import of `node:os`, if Effect has no way to ask the system for the home directory (Task 5). Any rule that seems wrong for a piece of code: stop and report, do not lower it. Known
  consequences: a Schema class takes the brand the rule asks for and is built with `X.make(…)`; a service key is
  `@llama-webui/app/server/<path>/<Name>`; an exported function of two or more parameters is `dual` or takes one
  options object (`missingPipeableSignature`); a `yield*` is bound to a `const` before it is passed to a call
  (`yieldInCallArgument`); number schemas are `Schema.Int`/`Schema.Finite`, never `Schema.Number` (`schemaNumber`).
- Idiomatic Effect only: services are `Context.Service` classes with a `static readonly layer`, methods are
  `Effect.fn('Service.method')`, errors are `Schema.TaggedError` classes, time comes from `Clock`/`DateTime`,
  configuration from `Config`, files from `FileSystem`, processes from `effect/process`. Promise code wrapped in
  `Effect.promise` does not count as ported. `app/server/settings/` is the model of a domain.
- `app/server-legacy/` is the Nitro server, a read-only reference: port its behaviour, not its structure; never import
  it. Only Task 9 deletes files in it. `site/` is not touched (the documentation is synced at E10, so the "docs in
  sync" rule of `CLAUDE.md` does not apply here).
- Server and shared code runs under Node as it is: relative imports end in `.ts`, erasable syntax only.
- No dependency is added. The server bundle keeps requiring nothing but Node builtins.
- **Never start anything on port 7860 or 7861.** Any run of the build or of `pnpm dev` carries a scratch data folder
  (`--data-dir <new temporary folder>`, or `LLAMA_WEBUI_DATA_DIR` for dev) and a free port: the default data folder is
  the user's real one, which the server would write to.
- Code, comments, test names, messages and commits in English. Commits end with
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- `pnpm lint`, `pnpm check` and `pnpm test` green at the end of every task. Zero Biome warning; do not disable a Biome
  rule. Format a Markdown or JSON file you wrote with `pnpm exec biome check --write <file>`.
- Shell: zsh (quote globs: `--include='*.ts'`); start a command with `cd /home/tristan/DEV/llama-webui`, the working
  directory does not always persist.

## Facts verified on this tree

Found by reading `repos/effect` and by a throwaway test against the installed version; rely on them.

- **Decode order of an endpoint** (`http-api/HttpApiBuilder.ts`): path params, headers, query, then the payload, then
  the handler. A failure is an `HttpApiError.HttpApiSchemaError` with `kind` (`"Params" | "Headers" | "Query" |
  "Payload" | "Body" | "ResponseHeaders"`) and `cause: Schema.SchemaError`; left alone it is an empty 400.
- **`HttpApiMiddleware.layerSchemaErrorTransform(Service, (error, { endpoint, group }) => Effect<HttpServerResponse,
  DeclaredError | HttpApiSchemaError>)`** turns it into the errors the middleware declares
  (`class X extends HttpApiMiddleware.Service<X>()('<key>', { error: [A, B] }) {}`). Observed over real HTTP with such a
  middleware: a payload `{"name":"","port":70000,"extra":1}` answers 400
  `{"_tag":"RequestInvalid","message":"Invalid data: Expected no excess property (extra)","issues":[{"path":["extra"],…},{"path":["name"],"message":"cannot be empty"},{"path":["port"],"message":"port between 1 and 65535"}]}`;
  a body `{`, an empty body and a body `[1]` answer 400 with one issue of empty path (`Expected a valid JSON body`,
  `Expected object`); `GET /things/abc` and `/things/0` with an id schema answer the 404 the transform chose.
- **`HttpApi.middleware(X)` only reaches the groups already added**: call it after the last `.add(…)`.
- **Strict payloads:** `.annotate(HttpApi.PayloadParseOptions, { onExcessProperty: 'error', errors: 'all' })` on the
  API makes an unknown key an issue and reports every issue, for the payload only (headers keep the defaults). It does
  not reach a schema decoded by hand (`Schema.decodeUnknownResult(schema, options)` takes the same options).
- **The derived client encodes the payload with the same schema before sending**: an invalid payload fails in the
  client with a `Schema.SchemaError` and no request is made. A reply that does not decode is something else (an
  `HttpClientError` whose reason is a `DecodeError`). So a server validation test goes over raw HTTP (`ServerTest` of
  `app/server/testing/http.ts`), not the typed client of `HttpApiTest`.
- **Messages:** `Schema.String.annotate({ message })` words a wrong type, a check takes `{ message }`
  (`Schema.isMinLength(1, { message: 'cannot be empty' })`), `.annotateKey({ messageMissingKey: 'required' })` words a
  missing key. `messageUnexpectedKey` (annotation, `Schema.ts` near line 19039) words an unknown key: not tried, the
  test of Task 3 pins it. `SchemaIssue.makeFormatterStandardSchemaV1()` gives `{ issues: [{ path, message }] }`
  (`app/server/settings/SettingsRepo.ts` uses it).
- **A handler may return an `HttpServerResponse`** from `handlers.handle(…)`: it is sent as is.
  `HttpServerResponse.text(body, { contentType: 'application/json', headers: { 'content-disposition': … } })` was
  observed to send `content-type: application/json` and the header. An endpoint with no `success` answers 204 with no
  body and no content type. `success: X.pipe(HttpApiSchema.status(201))` answers 201.
- **Routing:** a literal segment wins over a parameter whatever the order of declaration (`/things/export` next to
  `/things/:id`). The router matches a trailing slash (`/things/12/` reaches `/things/:id`): the redirect of Task 2 is
  a middleware in front of it.
- **Child processes:** `effect/process` (`ChildProcess.make(command, args, options)`, the `ChildProcessSpawner`
  service: `spawn`, `string`, `lines`), provided by `NodeServices.layer` (`app/server/runtime/runApp.ts`).
  `spawner.string` collects the output without looking at the exit code: read the handle's `exitCode` yourself.
- **Test doubles of llama.cpp:** `testdata/fake/fake-llama-server` (a shell script that forwards to
  `fake-llama-server.ts`) answers `--help` with a short catalogue and exits 0.
- `packages/webui-shared/src/profile.ts` is the last user of `ProfileInputSchema`; its other importers are
  `profile.test.ts` and `app/src/lib/profiles.ts`.

## Reference files

- Legacy behaviour (read, never import): `app/server-legacy/lib/db/profiles.ts` (the repository: SQL, the copy
  numbering, timestamps), `app/server-legacy/lib/llamatui.ts`, `app/server-legacy/lib/profiles/remove.ts`,
  `app/server-legacy/lib/supervisor/flags.ts` and `args.ts` (`expandHome`), `app/server-legacy/lib/http.ts`
  (`attachment`), `app/server-legacy/routes/api/profiles/**`, `app/server-legacy/routes/api/flags.get.ts`,
  `packages/llamacpp-js/src/node.ts` (`loadFlags`) and `flags.ts` (`parseHelp`).
- The model of each part: `packages/webui-shared/src/settings.ts` and `api/SettingsApi.ts` (schemas with messages, a
  group), `app/server/settings/SettingsRepo.ts` (+ test) and `settings/http.ts` (+ test), `app/server/http/Guard.ts`
  (a middleware of the edge), `app/server/contract/cases.ts`, `app/src/lib/settings.ts` (a web store on `call`).

## Review Focus

What a person will meet that the acceptance list does not spell out; each line is pinned by a test in the task named.

1. A profile name with quotes, a slash, an emoji or non-ASCII letters: the 409 message quotes it as it is, the export
   file name is percent-encoded and the reply is still valid JSON (Tasks 4 and 6).
2. An import body that is not what the page sends (`null`, a number, a string, `{ "profiles": "x" }`, an array whose
   items are not objects, an empty body): a 200 that explains each skip, never a 500 (Tasks 3 and 6).
3. A llama-tui config that is a directory, cannot be read, is not JSON, or is JSON but not an object: the status
   endpoint answers 200 with `error`, the import answers its 400, never a 500 (Task 5).
4. A `--help` that never ends, exits with a failure, prints nothing useful, or a binary that does not exist: a 503
   within 5 s, the process killed, and the next request tries again; two requests at once run it once (Task 7).
5. A redirect target is always a path of this server: `/api//` and `/api/profiles//` lose every trailing slash, the
   query is kept, a refused request (foreign `Origin`) is refused, not redirected (Task 2).

---

### Task 1: One answer for a request that does not decode

**Files:**

- Modify: `packages/webui-shared/src/api/errors.ts`, `packages/webui-shared/src/api/Api.ts`,
  `packages/webui-shared/src/api/SettingsApi.ts`, `packages/webui-shared/src/index.ts`
- Create: `packages/webui-shared/src/api/RequestErrors.ts`, `packages/webui-shared/src/api/params.ts`,
  `packages/webui-shared/src/api/errors.test.ts`
- Create: `app/server/http/RequestErrors.ts`, `app/server/http/RequestErrors.test.ts`
- Modify: `app/server/http/HttpLive.ts`, `app/server/testing/services.ts`, `app/server/settings/SettingsRepo.ts`,
  `app/server/contract/golden.json`, `app/src/lib/api.ts`, `app/src/lib/api.test.ts`

**Interfaces (produced):**

```ts
// packages/webui-shared/src/api/errors.ts
/** One field a request fails on: its path (keys and indexes as strings) and why. */
export const Issue = Schema.Struct({ path: Schema.Array(Schema.String), message: Schema.String });
export type Issue = typeof Issue.Type;
/** The issues of a decode failure, in the order Schema reports them. */
export const issuesOf: (issue: SchemaIssue.Issue) => ReadonlyArray<Issue>;
/** A request whose payload or query does not decode: 400, `Invalid data: <first message>[ (<path joined by '.'>)]`. */
export class RequestInvalid extends Schema.TaggedError<…>()('RequestInvalid',
  { message: Schema.String, issues: Schema.Array(Issue) }, { httpApiStatus: 400 }) {}
export const requestInvalid: (issue: SchemaIssue.Issue) => RequestInvalid;

// packages/webui-shared/src/api/RequestErrors.ts
/** The middleware every endpoint carries: what a request that does not decode is answered. */
export class RequestErrors extends HttpApiMiddleware.Service<RequestErrors>()(
  '@llama-webui/shared/api/RequestErrors', { error: [RequestInvalid, RouteNotFound] }) {}

// packages/webui-shared/src/api/params.ts
/** A row id in a path: a positive integer written in decimal digits. */
export const IdParam: Schema.Codec<number, string>;

// app/server/http/RequestErrors.ts
export const RequestErrorsLive: Layer.Layer<RequestErrors>;
```

- `SettingsInvalid.issues` becomes `Schema.Array(Issue)` and `SettingsRepo` builds them with `issuesOf` (its own copy
  of the mapping goes).
- `Api` gets `.annotate(HttpApi.PayloadParseOptions, { onExcessProperty: 'error', errors: 'all' })` and, **after the
  last `.add(…)`**, `.middleware(RequestErrors)`. A comment on the class says a group is added above these two lines.
- `RequestErrorsLive`: `kind === 'Params'` fails with `RouteNotFound.make({ message: 'Unknown route' })`; `'Payload'`,
  `'Query'` and `'Headers'` fail with `requestInvalid(error.cause.issue)`; `'Body'` and `'ResponseHeaders'` (a reply
  that does not encode, a bug of ours) fail with the error unchanged.
- `RequestErrorsLive` is provided where the handlers are (`ApiRoutes` of `HttpLive.ts`) and merged into `ServicesTest`,
  so the group tests built on `HttpApiTest.groups` keep working.
- Web: in `makeCall` (`app/src/lib/api.ts`), a `Schema.SchemaError` of a call (the payload the client refused to send)
  becomes `requestInvalid(error.issue)`: a caller sees the same `RequestInvalid` whether the client or the server
  refused. Check `pnpm --filter @llama-webui/app typecheck` still passes with the middleware on `Api` (the cast in
  `makeCall` says the client needs nothing but the HTTP client: true, this middleware has no client part).

- [ ] **Step 1: Write the failing tests.**

`packages/webui-shared/src/api/errors.test.ts` (plain Vitest, as the package's other tests):

```ts
test('requestInvalid words the first issue with its path and lists them all', () => {
  const schema = Schema.Struct({ name: Schema.String.check(Schema.isMinLength(1, { message: 'cannot be empty' })), args: Schema.Array(Schema.String) });
  const result = Schema.decodeUnknownResult(schema, { errors: 'all' })({ name: '', args: ['a', 3] });
  // Result.isFailure(result) holds; with its SchemaError `e`:
  const error = requestInvalid(e.issue);
  expect(error.message).toBe('Invalid data: cannot be empty (name)');
  expect(error.issues).toEqual([
    { path: ['name'], message: 'cannot be empty' },
    { path: ['args', '1'], message: expect.any(String) },
  ]);
});
test('an issue of the whole value has no path in the message', …); // decoding `[1]` → message 'Invalid data: Expected object', issues[0].path []
test('IdParam reads decimal digits only', …); // '12' → 12; 'abc', '0', '-1', '1.5', '' fail
```

`app/server/http/RequestErrors.test.ts`: a two-endpoint API of the test's own (a `POST /api/things` with a payload
struct, a `GET /api/things/:id` with `IdParam`), annotated and given the middleware as `Api` is, served on `ServerTest`:

```ts
it.effect('a payload that does not decode is a 400 RequestInvalid with every issue', …);
// POST {"name":"","extra":1} → 400, body._tag 'RequestInvalid', issues paths [['extra'], ['name']] (any order)
it.effect('a body that is not JSON, is empty or is not an object is a 400 RequestInvalid, never an empty 400', …);
// '{' → message 'Invalid data: Expected a valid JSON body'; '' and '[1]' → 400 with one issue of path []
it.effect('a path parameter that does not decode is the 404 of an unknown route', …);
// GET /api/things/abc and /api/things/0 → 404 { _tag: 'RouteNotFound', message: 'Unknown route' }
it.effect('a refused request is not logged as a failure', …); // the error logger of HttpLive.test.ts stays empty
```

`app/src/lib/api.test.ts`:

```ts
test('a payload the client refuses to send rejects as the RequestInvalid the server would answer', …);
// makeCall on a one-endpoint API with a struct payload, fetchImpl a vi.fn(): the call rejects with
// _tag 'RequestInvalid', issues [{ path: ['name'], message: 'cannot be empty' }], and fetchImpl was not called
```

- [ ] **Step 2: Run them, see them fail.** `LLAMA_WEBUI_TEST_BUILD=0 pnpm exec vitest run packages/webui-shared/src/api/errors.test.ts app/server/http/RequestErrors.test.ts app/src/lib/api.test.ts`
- [ ] **Step 3: Implement** the interfaces above.
- [ ] **Step 4: Run them, see them pass**, then the whole suite. The contract case
      `PATCH /api/settings (malformed JSON)` changes (a bare 400 becomes the `RequestInvalid` above): rewrite the
      record with `UPDATE_GOLDEN=1 pnpm exec vitest run app/server/contract/contract.test.ts` and check
      `git diff app/server/contract/golden.json` shows that case only.
- [ ] **Step 5: Commit** `feat(server): Answer a request that does not decode with a typed error`

### Task 2: A trailing slash redirects

**Files:**

- Create: `app/server/http/TrailingSlash.ts`, `app/server/http/TrailingSlash.test.ts`
- Modify: `app/server/http/HttpLive.ts`, `app/server/contract/cases.ts`, `app/server/contract/cases.test.ts`,
  `app/server/contract/contract.test.ts`, `app/server/contract/golden.json`

**Interfaces (produced):**

```ts
// app/server/http/TrailingSlash.ts
/**
 * A path under /api/ or /ws/ that ends with a slash is answered 308 to the same path without its trailing slashes,
 * query string kept; any other request goes on.
 */
export const noTrailingSlash: <E, R>(
  app: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
) => Effect.Effect<HttpServerResponse.HttpServerResponse, E, R | HttpServerRequest.HttpServerRequest>;

// app/server/contract/cases.ts
export type CaseKind = 'read' | 'write' | 'violation' | 'refusal' | 'body' | 'guard' | 'other' | 'web';
/** Whether a request (its path may carry a query string) is a use of `endpoint` (`METHOD /path/:param`). */
export function covers(endpoint: string, req: { method: string; path: string }): boolean;
```

- `serve` runs it inside the guard: `middleware: (app) => app.pipe(noTrailingSlash, logDefects, guard)`. The 308 has
  no body and one header, `location`.
- Contract: `'location'` joins `KEPT_HEADERS`; `refusal` is "a valid request the domain refuses (a 404 of a missing
  row, a 409)" and joins the kinds that must answer 400 or more; the coverage test uses `covers`, where a `:param`
  segment matches one non-empty segment and a literal segment only itself.

- [ ] **Step 1: Write the failing tests.**

`TrailingSlash.test.ts` (the API routes and a page served by `serve` on `ServerTest`, as `HttpLive.test.ts` builds its
app; the client must not follow redirects):

```ts
it.effect('an /api path with a trailing slash is a 308 to the path without it, query kept', …);
// GET /api/settings/ → 308, location '/api/settings', empty body; GET /api/settings/?a=1&b=/ → '/api/settings?a=1&b=/'
// PATCH /api/settings/ with a JSON body → 308 (the method is the client's to replay)
it.effect('every trailing slash goes, and the target stays a path of this server', …);
// /api/settings// → '/api/settings'; /api// → '/api'; /api/ → '/api'; /ws/ → '/ws'
it.effect('the guard answers first', …); // GET /api/settings/ with Origin http://evil.example → 403, no location
it.effect('a path of the UI keeps its slash', …); // GET /profiles/ → 200 the page; GET / → 200
```

`cases.test.ts`:

```ts
test('covers matches a parameter segment, ignores a query string, and tells literal segments apart', () => {
  expect(covers('GET /api/profiles/:id', { method: 'GET', path: '/api/profiles/12' })).toBe(true);
  expect(covers('GET /api/profiles/:id', { method: 'GET', path: '/api/profiles/12?x=1' })).toBe(true);
  expect(covers('GET /api/profiles/:id', { method: 'GET', path: '/api/profiles' })).toBe(false);
  expect(covers('GET /api/profiles/:id', { method: 'GET', path: '/api/profiles/12/export' })).toBe(false);
  expect(covers('GET /api/profiles/:id', { method: 'DELETE', path: '/api/profiles/12' })).toBe(false);
  expect(covers('GET /api/profiles/export', { method: 'GET', path: '/api/profiles/export' })).toBe(true);
});
```

- [ ] **Step 2: Run them, see them fail.**
- [ ] **Step 3: Implement.** Read the path as `Guard.ts` does (`pathOf`).
- [ ] **Step 4: Contract.** Keep the case `GET /api/settings/ (trailing slash)` and add
      `GET /api/settings/?x=1 (trailing slash, query)`. Rewrite the record; the diff shows the first case going from
      the settings to a 308 with `location: /api/settings`, and the new case.
- [ ] **Step 5: Run the whole suite, commit** `feat(server): Redirect a trailing slash under /api and /ws`

### Task 3: Profile schemas and the definition of the two groups

**Files:**

- Modify: `packages/webui-shared/src/profile.ts`, `packages/webui-shared/src/profile.test.ts`,
  `packages/webui-shared/src/index.ts`, `tsconfig.effect.json` (add `packages/webui-shared/src/profile.ts` to the
  third override's `include`)
- Create: `packages/webui-shared/src/api/ProfilesApi.ts`, `packages/webui-shared/src/api/FlagsApi.ts`

The groups are defined here and added to `Api` by the task that implements them (6 and 7): an endpoint of `Api`
without a handler does not compile, and one without a contract case fails the suite.

**Interfaces (produced):**

```ts
// packages/webui-shared/src/profile.ts — RESERVED_FLAGS, reservedFlag, reservedFlagMessage unchanged
/** The parse options of anything a person wrote: an unknown key is an error, every issue is reported. */
export const STRICT: SchemaAST.ParseOptions; // { onExcessProperty: 'error', errors: 'all' }
/** A profile as llama-tui writes it in its config (the import and export format). */
export const ProfileInput: Schema.Struct<…>; export type ProfileInput = typeof ProfileInput.Type;
export const ProfileSource = Schema.Literals(['ui', 'import', 'llama-tui']); export type ProfileSource = …;
export const Profile: Schema.Struct<…>;      export type Profile = typeof Profile.Type;
// ProfileInput's fields + id: Schema.Int, source: ProfileSource, createdAt: Schema.Int, updatedAt: Schema.Int (epoch ms)
export interface ProfileImport { profiles: ProfileInput[]; rejected: { name: string; reason: string }[] }
export function parseProfileImport(raw: unknown): ProfileImport; // same rules and wording as today

// packages/webui-shared/src/api/ProfilesApi.ts
export class ProfileNotFound …('ProfileNotFound', { message }, { httpApiStatus: 404 })   // 'Profile not found'
export class ProfileNameTaken …('ProfileNameTaken', { message }, { httpApiStatus: 409 }) // 'A profile named “<name>” already exists'
export class LlamaTuiConfigNotFound …(…, { message }, { httpApiStatus: 404 })   // 'llama-tui config not found (<path>)'
export class LlamaTuiConfigUnreadable …(…, { message }, { httpApiStatus: 400 }) // 'Unreadable llama-tui config: <error>'
export const ProfilesFile = Schema.Struct({ profiles: Schema.Array(ProfileInput) });
export const ImportResult = Schema.Struct({ imported: Schema.Array(Profile),
  skipped: Schema.Array(Schema.Struct({ name: Schema.String, reason: Schema.String })) });
export const LlamaTuiStatus = Schema.Struct({ path: Schema.String, exists: Schema.Boolean, names: Schema.Array(Schema.String),
  error: Schema.optionalKey(Schema.String), dismissed: Schema.Boolean, profileCount: Schema.Int });
export class ProfilesApi extends HttpApiGroup.make('profiles').add(…) {}

// packages/webui-shared/src/api/FlagsApi.ts
export class FlagsUnavailable …('FlagsUnavailable', { message }, { httpApiStatus: 503 }) // 'llama-server --help failed (<binary>)'
export const Flag: Schema.Struct<…>; // { names: string[], value?: string, help: string, section: string }, the `Flag` of llamacpp-js
export class FlagsApi extends HttpApiGroup.make('flags').add(
  HttpApiEndpoint.get('get', '/api/flags', { success: Schema.Struct({ flags: Schema.Array(Flag) }), error: FlagsUnavailable })) {}
```

The endpoints of `profiles` (name, method and path, payload, success, errors beyond the middleware's):

| Name             | Endpoint                              | Payload          | Success          | Errors                                               |
| ---------------- | ------------------------------------- | ---------------- | ---------------- | ---------------------------------------------------- |
| `list`           | `GET /api/profiles`                   |                  | `Array(Profile)` |                                                      |
| `create`         | `POST /api/profiles`                  | `ProfileInput`   | `Profile`, 201   | `ProfileNameTaken`                                   |
| `exportAll`      | `GET /api/profiles/export`            |                  | `ProfilesFile`   |                                                      |
| `importMany`     | `POST /api/profiles/import`           | `Schema.Unknown` | `ImportResult`   |                                                      |
| `llamaTuiStatus` | `GET /api/profiles/import/llama-tui`  |                  | `LlamaTuiStatus` |                                                      |
| `importLlamaTui` | `POST /api/profiles/import/llama-tui` |                  | `ImportResult`   | `LlamaTuiConfigNotFound`, `LlamaTuiConfigUnreadable` |
| `get`            | `GET /api/profiles/:id`               |                  | `Profile`        | `ProfileNotFound`                                    |
| `update`         | `PUT /api/profiles/:id`               | `ProfileInput`   | `Profile`        | `ProfileNotFound`, `ProfileNameTaken`                |
| `remove`         | `DELETE /api/profiles/:id`            |                  | none (204)       | `ProfileNotFound`                                    |
| `duplicate`      | `POST /api/profiles/:id/duplicate`    |                  | `Profile`, 201   | `ProfileNotFound`                                    |
| `exportOne`      | `GET /api/profiles/:id/export`        |                  | `ProfileInput`   | `ProfileNotFound`                                    |

Every `:id` is `params: { id: IdParam }`.

**`ProfileInput`, rule for rule from the zod schema it replaces** (read it in `profile.ts` before removing it):

- `name`, `model`: strings, message `required` when missing or not a string, `cannot be empty` when empty.
- `mmproj`, `cwd`, `host`: optional strings (`Schema.optionalKey`: an absent key stays absent, so a stored profile
  carries an optional field only when it is set).
- `port`: optional; `expected a number` for a non-number, `expected an integer` for a fraction,
  `port between 1 and 65535` out of bounds.
- `args`: array of strings, default `[]`; `env`: record of strings, default `{}` (`Schema.withDecodingDefaultKey`, as
  `settings.ts`).
- Each argument that `reservedFlag` matches is an issue at path `['args', <its index>]` with `reservedFlagMessage`
  (one issue per offending argument).
- An unknown key is an issue at the key, worded `unknown key`.
- zod leaves `profile.ts`; `parseProfileImport` decodes each item with `STRICT` and words a rejection as
  `<first issue's message>[ (<path joined by '.'>)]`, as before.

- [ ] **Step 1: Rewrite `profile.test.ts` first.** Keep its three tests (the whole llama-tui config of
      `testdata/llama-tui-config.json`, valid ones kept and invalid ones explained, a single profile and an array) on
      the new exports, and add (decoding with `Schema.decodeUnknownResult(ProfileInput, STRICT)`, issues read with
      `issuesOf`):

```ts
test('ProfileInput: a missing or empty name or model says so', …);
// {} → issues [{ path: ['name'], message: 'required' }, { path: ['model'], message: 'required' }]
// { name: '', model: 3 } → 'cannot be empty' at name, 'required' at model
test('ProfileInput: the port is an integer from 1 to 65535', …);
// 0 and 65536 → 'port between 1 and 65535'; 1.5 → 'expected an integer'; '80' → 'expected a number'; 1 and 65535 pass
test('ProfileInput: a reserved flag is refused where it stands, in both forms', …);
// args ['-c', '4096', '--host=0.0.0.0', '-m', 'x'] → issues at ['args','2'] ('--host is managed by llama-webui (use the
// profile fields)') and ['args','3'] ('-m is managed …'), nothing at index 0, 1 or 4
test('ProfileInput: an unknown key is refused, so a stored profile is not an input', …);
// { name: 'a', model: 'm', id: 1 } → [{ path: ['id'], message: 'unknown key' }]
test('ProfileInput: args and env default to empty, an absent optional field stays absent', …);
// { name: 'a', model: 'm' } → { name: 'a', model: 'm', args: [], env: {} } (toEqual, and 'mmproj' in value is false)
test('import: a body that holds no profile is one skip, an item that is not an object is explained', …);
// null, 3, 'x', {}, { profiles: 'x' } → { profiles: [], rejected: [{ name: '(file)', reason: 'no profile found in this JSON' }] }
// [3, { name: 'a' }] → two rejections, named '(unnamed)' and 'a', the second with reason 'required (model)'
// two valid items of the same name → the second rejected with 'duplicate name in the file'
```

- [ ] **Step 2: Run it, see it fail.** `pnpm exec vitest run packages/webui-shared/src/profile.test.ts`
- [ ] **Step 3: Implement** the schemas and the two group modules, export them from `index.ts`. The web still imports
      `ProfileInputSchema` nowhere reachable (`app/src/lib/profiles.ts` is not type-checked until Task 8).
- [ ] **Step 4: Run the suite and `pnpm check`** (zero `effect(` line: `profile.ts` now follows the server's rules).
- [ ] **Step 5: Commit** `feat(shared): Define profiles and flags on Effect Schema`

### Task 4: The profiles repository

**Files:**

- Create: `app/server/profiles/ProfilesRepo.ts`, `app/server/profiles/ProfilesRepo.test.ts`
- Modify: `app/server/App.ts`, `app/server/testing/services.ts` (the layer joins `Services` and `ServicesTest`)

**Interfaces (produced):**

```ts
export class ProfilesRepo extends Context.Service<
  ProfilesRepo,
  {
    /** Every profile, by name whatever the case. */
    readonly list: Effect.Effect<ReadonlyArray<Profile>>;
    readonly count: Effect.Effect<number>;
    readonly get: (id: number) => Effect.Effect<Profile, ProfileNotFound>;
    /** A new profile of source `ui`. */
    readonly create: (input: ProfileInput) => Effect.Effect<Profile, ProfileNameTaken>;
    /** Replaces every field of the input; `source` and `createdAt` stay, `updatedAt` moves. */
    readonly update: (change: {
      readonly id: number;
      readonly input: ProfileInput;
    }) => Effect.Effect<Profile, ProfileNotFound | ProfileNameTaken>;
    readonly remove: (id: number) => Effect.Effect<void, ProfileNotFound>;
    /** A copy under the first free name: `<name> (copy)`, `<name> (copy 2)`… A `llama-tui` source becomes `import`. */
    readonly duplicate: (id: number) => Effect.Effect<Profile, ProfileNotFound>;
    /** Creates each input in one transaction; one whose name exists is skipped with reason `already exists`. */
    readonly importMany: (batch: {
      readonly inputs: ReadonlyArray<ProfileInput>;
      readonly source: ProfileSource;
    }) => Effect.Effect<{
      readonly imported: ReadonlyArray<Profile>;
      readonly skipped: ReadonlyArray<{ readonly name: string; readonly reason: string }>;
    }>;
  }
>()('@llama-webui/app/server/profiles/ProfilesRepo') {
  static readonly layer: Layer.Layer<ProfilesRepo, never, SqlClient.SqlClient>;
}
```

Port the SQL, the name comparison, the copy numbering and the row mapping from `app/server-legacy/lib/db/profiles.ts`
(table `profiles`, already created by the migrations of E1). A stored row is decoded into `Profile` (`args_json` and
`env_json` through Schema, not `JSON.parse`); a NULL optional column gives no key. An SQL failure is a defect
(`SettingsRepo` shows how); the name taken is detected as the legacy code does, inside the same transaction as the
write.

- [ ] **Step 1: Write the failing tests** (`layer(…)` over an in-memory database, as `SettingsRepo.test.ts`):

```ts
it.effect('create stores a profile of source ui, with only the optional fields it was given', …);
it.effect('create and update refuse a name another profile has, quoting it as written', …);
// names 'A', then 'A' again → ProfileNameTaken, message 'A profile named “A” already exists'; same for
// 'say "hi" / ünï 🦙' (the message carries the name unchanged); update of a profile to its own name passes
it.effect('update replaces every field, keeps source and createdAt, moves updatedAt', …);
// a profile created with mmproj, port, args and env, updated with { name, model } only: mmproj and port are gone,
// args [] and env {}, source and createdAt as before, updatedAt later (TestClock.adjust between the two)
it.effect('get, update, remove and duplicate of an id that is not there fail with ProfileNotFound', …);
it.effect('list orders by name whatever the case', …); // created 'b', 'A', 'C', 'a' → ['A', 'a', 'b', 'C'] or ['a', 'A', …]: assert on lower-cased names ['a', 'a', 'b', 'c']
it.effect('duplicate numbers its copies and turns a llama-tui source into import', …);
// 'A' → 'A (copy)' → duplicate 'A' again → 'A (copy 2)' → again → 'A (copy 3)'; a profile imported with source
// 'llama-tui' duplicates as 'import'; a 'ui' one stays 'ui'
it.effect('importMany creates in one transaction and skips a name that exists', …);
// with 'A' stored: inputs [A, B] and source 'import' → imported [B (source 'import')], skipped [{ name: 'A', reason: 'already exists' }], count 2
it.effect('removing a profile keeps its conversations, bench runs and sweeps, without a profile', …);
// rows inserted by raw SQL with profile_id = the profile's id (read the columns in app/server/db/migrations.ts);
// after remove: the three rows remain with profile_id NULL
```

- [ ] **Step 2: Run them, see them fail.** `LLAMA_WEBUI_TEST_BUILD=0 pnpm exec vitest run app/server/profiles/ProfilesRepo.test.ts`
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the suite and `pnpm check`.**
- [ ] **Step 5: Commit** `feat(server): Store profiles`

### Task 5: Home and the llama-tui config

**Files:**

- Create: `app/server/config/Home.ts`, `app/server/config/Home.test.ts`, `app/server/profiles/LlamaTui.ts`,
  `app/server/profiles/LlamaTui.test.ts`
- Modify: `app/server/App.ts`, `app/server/testing/services.ts`

**Interfaces (produced):**

```ts
// app/server/config/Home.ts
/** The home directory: `HOME` when it is set and not empty, else the system's. */
export const homeDir: Effect.Effect<string>;
/** `~` and `~/…` expanded to the home directory; any other path as it is. */
export const expandHome: (path: string) => Effect.Effect<string>;

// app/server/profiles/LlamaTui.ts
export interface LlamaTuiConfig {
  readonly path: string;
  readonly exists: boolean;
  /** The config's `defaultProfile` when it is a string. */
  readonly defaultProfile: string | undefined;
  readonly profiles: ReadonlyArray<ProfileInput>;
  readonly rejected: ReadonlyArray<{ readonly name: string; readonly reason: string }>;
  /** Why the file could not be used: `Invalid JSON: <message>`, also for a file that cannot be read. */
  readonly error?: string;
}
export class LlamaTui extends Context.Service<LlamaTui, {
  /** `$XDG_CONFIG_HOME/llama-tui/config.json` when the variable is set and not empty, else `<home>/.config/llama-tui/config.json`. */
  readonly path: Effect.Effect<string>;
  readonly read: Effect.Effect<LlamaTuiConfig>;
}>()('@llama-webui/app/server/profiles/LlamaTui') { static readonly layer: Layer.Layer<LlamaTui, never, FileSystem.FileSystem | Path.Path> }
```

Port `app/server-legacy/lib/llamatui.ts` (what `exists` means, the wording of `error`, `parseProfileImport` for the
profiles). The variables are read through `Config` at each call, so a test sets them with a `ConfigProvider`.
`expandHome` ports `expandHome` of `app/server-legacy/lib/supervisor/args.ts`. The system's home is `homedir()` of
`node:os` (the legacy fallback) unless Effect offers it.

- [ ] **Step 1: Write the failing tests** (a temporary folder through `FileSystem.makeTempDirectoryScoped`):

```ts
// Home.test.ts
it.effect('expandHome expands ~ and ~/x, and nothing else', …); // HOME=/h: '~' → '/h', '~/bin/x' → '/h/bin/x', '~x', '/a/~', 'llama-server' unchanged
it.effect('an empty HOME falls back to the system home', …);
// LlamaTui.test.ts
it.effect('the config is under XDG_CONFIG_HOME, else under the home', …);
// XDG_CONFIG_HOME=/x → '/x/llama-tui/config.json'; unset or '' with HOME=/h → '/h/.config/llama-tui/config.json'
it.effect('a missing config is not an error', …); // exists false, profiles [], no error
it.effect('a config is read: its profiles, its rejections and its default profile', …);
// testdata/llama-tui-config.json copied in place: exists true, the names parseProfileImport gives, defaultProfile a string or undefined as the file says
it.effect('a config that is not JSON, not an object, a directory or unreadable has an error, not a failure', …);
// file 'nope' → error starts with 'Invalid JSON: '; file '[]' or '3' → rejected [{ name: '(file)', … }] or error, as the legacy code answers (pin what it does);
// a directory at the path, and a file of mode 000 (skip that half when the test runs as root) → error set, exists true, the effect succeeds
```

- [ ] **Step 2: Run them, see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the suite and `pnpm check`.**
- [ ] **Step 5: Commit** `feat(server): Read the llama-tui config`

### Task 6: The profiles over HTTP

**Files:**

- Create: `app/server/profiles/http.ts`, `app/server/profiles/http.test.ts`, `app/server/profiles/removeProfile.ts`,
  `app/server/http/attachment.ts`
- Modify: `packages/webui-shared/src/api/Api.ts` (`.add(ProfilesApi)`, above the annotation and the middleware),
  `app/server/http/HttpLive.ts`, `app/server/contract/cases.ts`, `app/server/contract/contract.test.ts`,
  `app/server/contract/golden.json`

**Interfaces (produced):**

```ts
// app/server/http/attachment.ts
/** A JSON file to download: 2-space indentation, a trailing newline, `content-type: application/json`,
 *  `content-disposition: attachment; filename*=UTF-8''<percent-encoded filename>`. */
export const attachment: (file: { readonly filename: string; readonly body: unknown }) => HttpServerResponse.HttpServerResponse;

// app/server/profiles/removeProfile.ts
/** Deletes a profile and, when it was the default one, clears the `defaultProfileId` setting. E3 adds the refusal of
 *  the running server's profile here. */
export const removeProfile: (id: number) => Effect.Effect<void, ProfileNotFound, ProfilesRepo | SettingsRepo>;

// app/server/profiles/http.ts
export const ProfilesHandlers: Layer.Layer<…>; // HttpApiBuilder.group(Api, 'profiles', …)
```

Handlers, from `app/server-legacy/routes/api/profiles/**` and section E2 of `behaviours.md`:

- `exportAll` and `exportOne` answer `attachment(…)`: `llama-webui-profiles.json` with `{ profiles: [...] }` in list
  order, and `<name>.json` with the one profile; both in import format (the fields of `ProfileInput` only, encoded
  with the schema). The body's JSON goes through Schema (`Schema.encode…`/a JSON codec), not `JSON.stringify` on a
  decoded value the rule `globalJson` would report; the two-space indentation is the one thing the file format adds.
- `importMany`: `parseProfileImport(payload)`, then `ProfilesRepo.importMany({ inputs, source: 'import' })`;
  `skipped` lists the parser's rejections first, then the repository's.
- `llamaTuiStatus`: `{ path, exists, names, error?, dismissed, profileCount }` (`dismissed` is the setting
  `llamaTuiImportDismissed`, `profileCount` the repository's count).
- `importLlamaTui`: a config that does not exist fails `LlamaTuiConfigNotFound` (`llama-tui config not found
  (<path>)`), one with an `error` fails `LlamaTuiConfigUnreadable` (`Unreadable llama-tui config: <error>`); else the
  import with source `llama-tui`, then, only while `defaultProfileId` is null and the config names a `defaultProfile`,
  the setting takes the id of the profile of that name (as the legacy route resolves it).
- `remove` is `removeProfile`.

- [ ] **Step 1: Write the failing handler tests** (`http.test.ts`). Typed client (`HttpApiTest.groups(Api,
      ['profiles'])` on `ServicesTest`) for what the web does, raw HTTP on `ServerTest` for statuses, headers and
      refused requests:

```ts
it.effect('create answers 201 with the stored profile, a taken name 409 ProfileNameTaken', …);
it.effect('an invalid profile is a 400 RequestInvalid naming each field, on create and on update', …);
// raw POST {"name":"","model":"m","port":0,"args":["--port","1"],"id":3} → 400, issues at name, port, args.0 and id
// raw PUT /api/profiles/1 with a full stored profile (id, source, dates) → 400 with 'unknown key' issues
it.effect('update of a profile that is not there is a 404 ProfileNotFound, an id that is not a number the unknown route', …);
// PUT /api/profiles/999 valid body → 404 { _tag: 'ProfileNotFound', message: 'Profile not found' }; GET /api/profiles/abc → 404 RouteNotFound
it.effect('remove answers 204 with no body and clears the default profile setting', …);
// defaultProfileId set to the profile: after DELETE it is null; deleting another profile leaves it
it.effect('duplicate answers 201 with the copy', …);
it.effect('both exports are files: indented, a trailing newline, a percent-encoded name', …);
// profile named 'né / "x" 🦙': GET /api/profiles/<id>/export → content-type application/json, content-disposition
// `attachment; filename*=UTF-8''${encodeURIComponent('né / "x" 🦙.json')}`, body text === `${JSON.stringify(input, null, 2)}\n`
// with no id, source or dates; GET /api/profiles/export → filename llama-webui-profiles.json, body { profiles: [...] } in list order
it.effect('import explains every skip and creates the rest, whatever the body', …);
// body { profiles: [valid 'B', { name: 'bad' }, valid 'B' again, valid 'A' (already stored)] } → 200, imported ['B'] with
// source 'import', skipped in order: bad 'required (model)', B 'duplicate name in the file', A 'already exists'
// bodies null, 3, "x", an empty body → 200 { imported: [], skipped: [{ name: '(file)', reason: 'no profile found in this JSON' }] }
it.effect('the llama-tui status reports a missing config, then its names and what is already imported', …);
it.effect('the llama-tui import refuses a missing config (404) and an unreadable one (400), with the path and the reason', …);
it.effect('the llama-tui import sets the default profile once', …);
// config with defaultProfile naming one of its profiles: defaultProfileId becomes that profile's id, source 'llama-tui';
// with defaultProfileId already set it is left alone
```

The llama-tui tests give `LlamaTui` a config path of their own (a `ConfigProvider` with `XDG_CONFIG_HOME` in a
temporary folder).

- [ ] **Step 2: Run them, see them fail.**
- [ ] **Step 3: Implement** the handlers, add the group to `Api` and the handlers to `ApiRoutes`.
- [ ] **Step 4: Contract.** The run's `beforeAll` writes `<home>/config/llama-tui/config.json` (a copy of
      `testdata/llama-tui-config.json`) before the app starts. Add these cases, in this order, after the settings
      cases and before any case of Task 7 (`refusal`: see Task 2):

| Kind        | Name                                              | Request                                                                                                                             |
| ----------- | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `read`      | `GET /api/profiles (none yet)`                    |                                                                                                                                     |
| `read`      | `GET /api/profiles/import/llama-tui`              |                                                                                                                                     |
| `write`     | `POST /api/profiles`                              | `{"name":"Alpha","model":"/models/a.gguf","port":8081,"args":["-c","4096"],"env":{"A":"1"}}`                                        |
| `violation` | `POST /api/profiles (schema violation)`           | `{"name":"","model":"m","port":70000,"args":["--port","1"],"extra":1}`                                                              |
| `body`      | `POST /api/profiles (malformed JSON)`             | `{`                                                                                                                                 |
| `refusal`   | `POST /api/profiles (name taken)`                 | `{"name":"Alpha","model":"m"}`                                                                                                      |
| `read`      | `GET /api/profiles/1`                             |                                                                                                                                     |
| `refusal`   | `GET /api/profiles/999 (no such profile)`         |                                                                                                                                     |
| `other`     | `GET /api/profiles/abc (id that is not a number)` |                                                                                                                                     |
| `write`     | `PUT /api/profiles/1`                             | `{"name":"Alpha 2","model":"/models/a.gguf"}`                                                                                       |
| `write`     | `POST /api/profiles/1/duplicate`                  |                                                                                                                                     |
| `read`      | `GET /api/profiles/1/export`                      |                                                                                                                                     |
| `read`      | `GET /api/profiles/export`                        |                                                                                                                                     |
| `write`     | `POST /api/profiles/import`                       | `{"profiles":[{"name":"Beta","model":"/models/b.gguf"},{"name":"bad"},{"name":"Beta","model":"x"},{"name":"Alpha 2","model":"x"}]}` |
| `write`     | `POST /api/profiles/import/llama-tui`             |                                                                                                                                     |
| `write`     | `DELETE /api/profiles/2`                          |                                                                                                                                     |
| `refusal`   | `DELETE /api/profiles/999 (no such profile)`      |                                                                                                                                     |
| `read`      | `GET /api/profiles (after the writes)`            |                                                                                                                                     |

      Record: `UPDATE_GOLDEN=1 pnpm exec vitest run app/server/contract/contract.test.ts`, then read
      `git diff app/server/contract/golden.json`: only new cases, each reply the one this task describes (201, 204
      without body or content type, the two `content-disposition` headers, 409, both 404 shapes), times recorded as
      `<time>`. An export reply is recorded as parsed JSON: its indentation is proven by the handler test.
- [ ] **Step 5: Run the whole suite, `pnpm check`, `pnpm build && node scripts/smoke.ts`.**
- [ ] **Step 6: Commit** `feat(server): Serve the profiles`

### Task 7: The flag catalogue

**Files:**

- Create: `app/server/flags/Flags.ts`, `app/server/flags/Flags.test.ts`, `app/server/flags/http.ts`,
  `app/server/flags/http.test.ts`
- Modify: `packages/webui-shared/src/api/Api.ts` (`.add(FlagsApi)`), `app/server/http/HttpLive.ts`, `app/server/App.ts`,
  `app/server/testing/services.ts`, `app/server/contract/cases.ts`, `app/server/contract/contract.test.ts`,
  `app/server/contract/golden.json`

**Interfaces (produced):**

```ts
export class Flags extends Context.Service<Flags, {
  /** The flags of the `binary` setting's `--help` (`~` expanded), read once per binary path for the life of the app. */
  readonly catalog: Effect.Effect<FlagCatalog, FlagsUnavailable>;
}>()('@llama-webui/app/server/flags/Flags') {
  static readonly layer: Layer.Layer<Flags, never, SettingsRepo | ChildProcessSpawner.ChildProcessSpawner>;
}
export const FlagsHandlers: Layer.Layer<…>; // GET /api/flags → { flags: catalog.flags }
```

- The run: `<binary> --help` through `effect/process`, its standard output read up to 16 MiB, parsed by `parseHelp`
  of `llamacpp-js` (the pure parser; `loadFlags` of `llamacpp-js/node` is Promise code and is not called). It fails
  with `FlagsUnavailable` (`llama-server --help failed (<binary>)`, the binary worded as
  `app/server-legacy/routes/api/flags.get.ts` words it) when the program cannot start, exits with a code other than 0,
  prints more than 16 MiB, lists no flag, or has not ended after 5 s (it is then killed).
- The cache: `Cache` of `effect`, keyed by the expanded binary path; a success stays for the life of the app, a failure
  is not kept; callers that arrive while a run is in flight share it. The `binary` setting is read at each call, so a
  changed setting reads the new binary.

- [ ] **Step 1: Write the failing tests.** `Flags.test.ts` runs small shell scripts written to a temporary folder
      (mode 755) and set as the `binary` setting; a script appends a line to a file each time it runs, which is how a
      test counts runs:

```ts
it.effect('the catalogue is the parsed --help, read once per binary', …); // testdata/fake/fake-llama-server: flags not empty; a counting script called 3 times in a row ran once
it.effect('callers at the same time share one run', …); // 5 concurrent calls on a script that sleeps 0.2 s: one run
it.effect('a changed binary setting reads the new binary', …);
it.effect('a failure is FlagsUnavailable naming the binary, and is tried again', …);
// a missing path, a script that exits 3, a script that prints no flag: each fails with the message; a script that
// fails on its first run and succeeds on its second (it reads its own counter) → the second call succeeds
it.effect('a --help that never ends fails after 5 s and its process is gone', …);
// a script that writes its pid then sleeps 60: the call fails with FlagsUnavailable once 5 s have passed (TestClock
// if the timeout honours it, else it.live with a real wait), and `kill -0 <pid>` then fails
it.effect('~ in the binary setting is the home directory', …);
```

`http.test.ts`: `GET /api/flags` answers `{ flags: [{ names, help, section, … }] }` for the fake, and 503
`{ _tag: 'FlagsUnavailable', message: 'llama-server --help failed (<binary>)' }` for a missing binary.

- [ ] **Step 2: Run them, see them fail.**
- [ ] **Step 3: Implement**, add the group to `Api`, the handlers to `ApiRoutes`, the layer to `Services` and
      `ServicesTest`.
- [ ] **Step 4: Contract.** The reply must not depend on the machine's `PATH`. `cases(ctx)` takes the fake's path and a
      missing one (`ctx: { asset, fake, missing }`, `fake` = `<repo>/testdata/fake/fake-llama-server`, `missing` =
      `<tmp>/no-such-llama-server`), and adds at the very end:
      `write` `PATCH /api/settings (binary: the fake llama-server)`, `read` `GET /api/flags`,
      `write` `PATCH /api/settings (binary: a program that is not there)`,
      `refusal` `GET /api/flags (--help fails)`. Record and read the diff (paths recorded as `<repo>/…` and `<tmp>/…`).
- [ ] **Step 5: Run the whole suite, `pnpm check`, `pnpm build && node scripts/smoke.ts`.**
- [ ] **Step 6: Commit** `feat(server): Read the flag catalogue of llama-server`

### Task 8: The Profiles page

**Files:**

- Modify: `app/src/lib/profiles.ts`, `app/src/lib/flags.ts`, `app/src/features/profiles/ProfilesPage.tsx`,
  `ProfileForm.tsx`, `ImportBanner.tsx`, `draft.ts` (and the other files of the folder as the type check asks),
  `app/src/app/router.tsx` (`PORTED` gets `/profiles`), `app/tsconfig.json` if a file of the feature is excluded
- Create: `app/src/features/profiles/errors.ts`, `app/src/features/profiles/errors.test.ts`

**Interfaces (produced):**

```ts
// app/src/features/profiles/errors.ts
/** The message of each form field a failed save names: an issue goes to its first path segment (`args.2` → `args`),
 *  a taken name to `name`; `form` holds what names no field (an unknown key, an unreachable server). */
export function fieldErrors(
  error: unknown,
): Partial<Record<'name' | 'model' | 'mmproj' | 'cwd' | 'host' | 'port' | 'args' | 'env' | 'form', string>>;
```

- `lib/profiles.ts` and `lib/flags.ts` call the derived client (`call((api) => api.profiles.list())`…), as
  `app/src/lib/settings.ts` does; their types come from the shared schemas (`Profile`, `ProfileInput`,
  `typeof ImportResult.Type`, `typeof LlamaTuiStatus.Type`). No `fetch('/api…')`, no cast on a reply. The two export
  links stay plain `<a href="/api/profiles/export" download>` links.
- A save sends the input fields only (`ProfileInput`): a stored profile carries `id`, `source` and dates, which the
  client would refuse as unknown keys.
- `ProfileForm` shows `fieldErrors(error)`; the flags store shows the message of `FlagsUnavailable`.
- **Parts that wait** (the rule of E1: a module reachable from `main.tsx` drops its imports of unported stores and
  pages, and nothing else changes in it):
  - E3 (`@/lib/server`): the running marker in the list, the preselection of the running profile, "Start this
    profile", the restart dialog after a save, the delete button disabled for the running profile. Removed, with no
    placeholder.
  - E6 (`@/lib/models`, `ModelPicker`): the model picker and the "create from model" prefill. The model and the
    projector become plain text inputs of a path (same labels, same field names).
  - Also restore whatever E1 left waiting for this milestone: `grep -rn 'milestone E2' app/src`.
- `draft.test.ts` runs again and stays green.

- [ ] **Step 1: Write the failing test** (`errors.test.ts`):

```ts
test('fieldErrors puts each issue on its field, the first one winning', () => {
  const error = RequestInvalid.make({ message: 'Invalid data: cannot be empty (name)', issues: [
    { path: ['name'], message: 'cannot be empty' }, { path: ['args', '2'], message: '--port is managed by llama-webui (use the profile fields)' },
    { path: ['args', '4'], message: 'later' }, { path: ['id'], message: 'unknown key' } ] });
  expect(fieldErrors(error)).toEqual({ name: 'cannot be empty', args: '--port is managed by llama-webui (use the profile fields)', form: 'unknown key (id)' });
});
test('a taken name is an error of the name field', …); // ProfileNameTaken.make({ message: 'A profile named “A” already exists' }) → { name: that message }
test('anything else is an error of the form', …);       // new ApiUnreachable() → { form: 'llama-webui server unreachable' }
```

- [ ] **Step 2: Run it, see it fail.**
- [ ] **Step 3: Implement**, then `pnpm check` (the page and its stores are type-checked again) and `pnpm test`.
- [ ] **Step 4: Try the page on the build.** `pnpm build`, then
      `node app/.output/llama-webui.mjs --host 127.0.0.1 --port <free port, not 7860 or 7861> --data-dir "$(mktemp -d)"`,
      and with `curl` on that port: create a profile, list it, fetch `/api/flags` (503 unless llama-server is
      installed), open `/profiles` (the page's HTML). Stop the server. Report what you ran.
- [ ] **Step 5: Commit** `feat(web): Bring the Profiles page back`

### Task 9: Close the milestone

**Files:**

- Modify: `docs/superpowers/poc-effect/behaviours.md`, `test-inventory.json`, `defects.md`, `conventions.md`
- Delete: the legacy files listed below
- Create: `docs/superpowers/poc-effect/e2.json`

- [ ] **Step 1: Behaviours.** In `behaviours.md`, section E2: every line is ticked with what proves it (a test by its
      file and name, or a contract case), in the format of section E1; a line that changed says how it behaves now
      (the calls at the top of this plan); every "Not covered by a test" line is ticked with the test this plan added.
      Moved, as a `From E2:` line in the section of its milestone: to E3 › Endpoints, the 409 of deleting the running
      server's profile (with its "Not covered by a test" line) and the page parts that wait for `@/lib/server`; to
      E6, the model picker and "create from model". In section E1, the line on the trailing slash (line 22) says the
      redirect, and its `moved to E2` sub-line (the 204 and the attachment) names their proofs.
- [ ] **Step 2: Tests.** In `test-inventory.json`, the five `E2` entries get a `status` (`ported` or `rewritten` with
      `to`), edited by a throwaway script, never regenerated. Run:
      `node -e "const a=require('./docs/superpowers/poc-effect/test-inventory.json');console.log(a.filter(e=>e.milestone==='E2'&&!e.status).length)"`
      (expected `0`). Three `E1` entries were dropped for behaviour that is back: add the new proof to their `reason`
      (`idParam() is a 404 for anything but a positive integer` → the `IdParam` and `RequestErrors` tests; the 204 of
      `api()` → the profile deletion; leave `queryOf()` as it is, no endpoint reads a query yet).
- [ ] **Step 3: Defects and deviations.** In `defects.md`: the three E2 lines become `not a defect` or `design choice`
      with the reason given at the top of this plan; under "Changed by the Effect server", the trailing slash moves
      from "Open" to "Decided (user): 308 to the path without it, under `/api/` and `/ws/`", the bare 400 line says it
      is now `RequestInvalid`, and the deviations of the second call of this plan are added, one line each.
- [ ] **Step 4: Conventions.** Add to `conventions.md`, from the code as it now is (a few lines each): request
      validation (payload schemas, `IdParam`, `RequestInvalid`, the strict payload annotation, the middleware added
      after the last group, validation tests over raw HTTP, `makeCall` mapping the client's refusal); a file reply
      (`attachment`); `refusal` cases, `covers`, and a contract case that needs a setting or a file; `Home`; running a
      program (`effect/process`, the exit code, the timeout); a web page with waiting parts.
- [ ] **Step 5: Legacy files.** Delete (`git rm`) what this milestone rewrote: `app/server-legacy/routes/api/profiles/`,
      `routes/api/flags.get.ts`, `lib/db/profiles.ts`, `lib/llamatui.ts`, `lib/supervisor/flags.ts`,
      `lib/schemas.test.ts`. Keep `lib/profiles/remove.ts` (E3). And what E1 rewrote and left:
      `routes/api/health.get.ts`, `routes/api/settings.get.ts`, `routes/api/settings.patch.ts`, `lib/db/settings.ts`,
      `lib/db/settings.test.ts`, `lib/cli.ts`, `lib/cli.test.ts`, `lib/security.ts`,
      `lib/security.test.ts`, `lib/version.ts`, `lib/version.test.ts`, `middleware/`, `error.ts`, `api.gen.ts`,
      `api.gen.test.ts`, `lib/apiTypes.ts` (`lib/env.ts` and its test stay: the proxy half is E6's). Nothing outside the
      folder may depend on them: the suite stays green.
      Delete nothing else there.
- [ ] **Step 6: Run everything, commit.**
      `pnpm lint && pnpm check && pnpm test && pnpm build && node scripts/smoke.ts`, then
      `pnpm check 2>&1 | grep -c 'effect('` (expected `0`).
      Commit `chore(poc): Close E2, the profiles`.
- [ ] **Step 7: Measure, on the clean tree.**
      `node scripts/poc/measure.ts --out docs/superpowers/poc-effect/e2.json`, then
      `pnpm exec biome format --write docs/superpowers/poc-effect/e2.json`, commit `chore(poc): Measure E2`.
- [ ] **Step 8: Report.** What was built per task; every deviation from this plan and why; every place the plan was
      wrong about Effect or the tree; every behaviour dropped, changed or moved; the parts of the page that wait and
      for which milestone; any `@effect-diagnostics` directive or override entry (expected: the two the constraints
      name); the
      commands of Task 8 Step 4 and what they answered; the numbers of `e2.json` next to `e1.json`; anything left
      undone.
