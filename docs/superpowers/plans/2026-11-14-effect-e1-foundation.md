# Effect POC, E1: Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Nitro server with an Effect 4 foundation: after E1 the production build starts from one Effect
entry point, serves the app shell and the Settings page, `/ws` and an SQLite database that an existing data directory
opens untouched, and stops in order on a signal. The Nitro server stays in the tree as a read-only reference.

**Architecture:** `packages/webui-shared` holds what the two sides share at runtime: Schema types, wire errors and the
`HttpApi` definition. `app/server/` is one application `Layer` (config, database, services, HTTP) run by `Layer.launch`
under `NodeRuntime.runMain`; one folder per concern, no `lib/` + `routes/` split. The web calls the API through a
client derived from the `HttpApi` definition. Vite builds the client only; Rolldown bundles the server.

**Tech Stack:** Effect 4.1.4 (`effect`, `effect/http`, `effect/http-api`, `effect/sql`, `effect/cli`,
`effect/socket`, `effect/devtools`), `@effect/platform-node`, `@effect/sql-sqlite-node`, `@effect/vitest`, Node ≥ 26.13,
Rolldown 1.2.18, Vite, Vitest 5, Biome.

**Spec:** `docs/superpowers/specs/2026-11-14-effect-server-design.md`. Acceptance list:
`docs/superpowers/poc-effect/behaviours.md`, section E1 (written by E0).

**Calls made by this plan** (the author's, listed for the user's review; each is recorded in `behaviours.md` by
Task 11):

- `GET /api/state` returns with E3 (its content is the supervisor's); `/api/health` carries `bootId` meanwhile
  (accepted by the user).
- One signal handler of our own remains: a second signal forces the exit (`NodeRuntime.runMain` only re-interrupts)
  (accepted by the user).
- Dropped with the Nitro server: the 405 with `Allow`, the 503 while starting, `.env.local` in dev, the route save
  that kept llama-server. A usage error of the launcher exits 1 (was 2); `--version` is new.
- Unported web code stays where it is, kept out of the type check by not being reachable (Task 3).
- `llama-webui.mjs` becomes a one-line launcher of `server/index.mjs`, which holds the CLI.
- `schema_version` is kept up to date, so the Nitro server still opens a database the Effect server opened.

## Global Constraints

- Branch `poc/effect`, after E0 (`docs/superpowers/poc-effect/` exists).
- **Before writing any Effect code, read `repos/effect/LLMS.md` completely**, then the reference files of the task.
  `repos/effect` is the installed version (4.1.4): read it, not `node_modules`, and never edit it.
- `CLAUDE.md` describes the Nitro server until Task 3 adds its note: where it contradicts this plan about the server,
  this plan wins. `site/` is not touched in this milestone: the spec syncs the documentation at E10, so the "docs in
  sync" rule of `CLAUDE.md` does not apply here.
- Idiomatic Effect only: services are `Context.Service` classes with a `static readonly layer`, methods are
  `Effect.fn('Service.method')` (the name is the span the DevTools show), errors are `Schema.TaggedError` classes,
  resources are scoped (`Effect.acquireRelease`, `Layer`), time comes from `Clock`/`DateTime`, configuration from
  `Config`, output from `Effect.log*`. Promise code wrapped in `Effect.promise` does not count as ported.
- **Effect diagnostics are blocking from Task 3 on (user):** `pnpm check` prints no `effect(<rule>)` line, warnings
  included. Fix what a rule reports with its own suggestion. The only exceptions, all set up by Task 3:
  - code that drives the build from outside (the first override of `tsconfig.effect.json`);
  - `// @effect-diagnostics-next-line nodeBuiltinImport:off` where an Effect API takes the Node builtin itself
    (`createServer` for `NodeHttpServer.layer`) or Effect has no equivalent (`parseEnv`, `isBuiltin`), with the reason
    on the line;
  - `// @effect-diagnostics-next-line processEnv:off` at the one place that writes `.env` into `process.env` (Task 4).

  Any other rule that seems wrong for a piece of code: stop and report, do not lower it. Consequences to know before
  writing: a Schema class takes the brand the rule asks for and is built with `X.make(…)`, not `new X(…)`; a service
  key is `@llama-webui/app/server/<path>/<Name>`.
- `app/server-legacy/` (created by Task 3) is a read-only reference, like `repos/`: port its behaviour, not its
  structure. No bridge code between the two servers, in either direction.
- Server and shared code runs under Node as it is: relative imports end in `.ts`, erasable syntax only (no `enum`, no
  `namespace`, no parameter property).
- The published package stays autonomous: `app/.output/` keeps `llama-webui.mjs`, `server/index.mjs`, `public/`,
  `server/THIRD-PARTY-LICENSES.md`; the server bundle requires nothing but Node builtins. No dependency is added to the
  root `package.json` or to `packages/llamacpp-js`.
- Launcher flags `--help`, `--host`, `--port`, `--data-dir`, `--env-override`, the `LLAMA_WEBUI_*` variables and the
  `.env` rules keep their behaviour.
- SQLite through `node:sqlite` (`@effect/sql-sqlite-node`); the database file and its schema do not change.
- Code, comments, test names, messages and commits in English. Commits end with
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- `pnpm lint`, `pnpm check` and `pnpm test` green at the end of every task, on the tree outside `app/server-legacy/`
  and `repos/`. Zero Biome warning. Do not disable a Biome rule: stop and report instead.
- Never start anything on port 7860 or 7861: tests and manual runs pick a free port.

## Facts verified on this tree

Run on Effect 4.1.4 before this plan was written (throwaway probes, not in the tree). Build on them.

- **Source run:** `node server/main.ts` starts an Effect HTTP + SQLite server in about 225 ms with type stripping
  alone. `@llama-webui/shared` does not load that way yet: its relative imports have no extension (Task 1).
- **Bundle:** `rolldown({ input, platform: 'node', output: { file, codeSplitting: false } })` gives one file of about
  900 KiB that starts in about 55 ms from any folder. Its static imports are all `node:*`; `ws` (bundled with
  `@effect/platform-node`) adds `require("http")`-style builtins and two optional native addons, `bufferutil` and
  `utf-8-validate`, which must resolve to a stub that throws (`ws` then uses its JavaScript fallback).
- **Client:** `HttpApiClient` + `FetchHttpClient` for a small `HttpApi` bundle to about 195 KiB minified (61 KiB
  gzip). `effect` contains the text `getBuiltinModule?.("node:async_hooks")`: a runtime probe, not an import.
- **Web without the old client:** with `app/server/` moved and `app/src/lib/api.ts` reduced to the new exports,
  `pnpm lint` stays clean on the untouched web files and every existing web and shared test still passes (they test
  pure helpers). Only `app/src/lib/api.ts` imports from the server folder.
- **WebSocket upgrade:** the handshake answer is sent when the socket's reader is acquired, so acquire it before the
  first write:

```ts
const request = yield* HttpServerRequest.HttpServerRequest;
const socket = yield* request.upgrade;
const pull = yield* Socket.readerString(socket); // the 101 leaves here
const { write } = yield* socket.writer;
yield* write(hello);
```

- **Shutdown:** when the scope of `HttpRouter.serve` closes, `NodeHttpServer` sends close code 1001 to every WebSocket
  itself, then waits `gracefulShutdownTimeout` (20 s by default) for open connections. Finalizers run in reverse
  build order, so the services the routes use are undone after the server closed. A step that must run while clients
  are still connected goes through a registry whose runner is the outermost layer (measured with a stream and a `/ws`
  open at SIGTERM: last stream event and clean end, then 1001, then the service finalizers, exit in 62 ms):

```ts
// Built last, so undone first: its finalizer runs the registered steps before the HTTP server stops serving.
const App = Shutdown.layerRunner.pipe(Layer.provide(Http), Layer.provide(Shutdown.layer));
```

- **Exit code:** `NodeRuntime.runMain` exits 130 on a signal and only re-interrupts on a second one. Exit code 0 and
  the forced exit are ours:

```ts
NodeRuntime.runMain(program, {
  teardown: (exit, onExit) => onExit(Exit.isSuccess(exit) || Cause.hasInterruptsOnly(exit.cause) ? 0 : 1),
});
```

- **Payload errors:** when a request payload does not decode, `HttpApi` answers a bare 400 with no detail. An
  endpoint whose page shows field errors takes a loose payload and validates in its service (Task 7).
- **SQLite:** `SqliteClient` keeps one connection, enables WAL, and leaves foreign keys **on** (the default of
  `node:sqlite`): a `PRAGMA foreign_keys` set outside a transaction holds for the following queries.
  `SqliteMigrator.run` runs every pending migration in one transaction and records them in
  `effect_sql_migrations (migration_id integer PRIMARY KEY NOT NULL, created_at datetime NOT NULL DEFAULT
  current_timestamp, name VARCHAR(255) NOT NULL)`; the key `0001_init` gives id 1, name `init`. A JavaScript number
  is always bound as REAL (`3` arrives as `3.0`; a column declared INTEGER stores it as an integer, an untyped column
  or a JSON function keeps the real); a boolean is bound as integer 1 or 0.
- **CLI (`effect/cli`):** `--opt=val` is accepted; an unknown flag, a missing value and a positional argument are
  refused (`Unrecognized flag: --nope in command llama-webui`, `Missing value for flag --host. Expected: string`,
  `Unexpected positional argument: "extra"`): the help then the error are printed and the run fails (exit 1).
  `Flag.Int('port')` with `Flag.withSchema` refuses `abc` and `70000`. An empty value (`--host ""`, `--data-dir=`) is
  accepted unless the flag has `Flag.withSchema(Schema.NonEmptyString)`. `Flag.Boolean` is required unless it has
  `Flag.withDefault(false)`. The built-in flags are `--help`/`-h`, `--version`, `--wizard`, `--completions` and
  `--log-level` (`CliConfig.layer({ builtIns })` chooses them).
- **Config:** the constructors are capitalised (`Config.String`, `Config.Port`, `Config.Boolean`). With
  `Config.withDefault`, a variable that is set but empty gives the default; `LLAMA_WEBUI_PORT=abc` fails with an error
  naming the variable.
- **Language service:** a project reports on its own files, those it imports from its folder included, and not on
  the sources of another package: the server project says nothing about `packages/webui-shared`. A plugin block
  inherited through `extends` applies. The globs of `overrides` are relative to the folder of the config file that
  declares them (`**/testing/**/*.ts`, `**/lifecycle.test.ts`, `packages/webui-shared/src/**/*.ts` from the root); an
  override is merged into the base map (a rule it does not name keeps its base severity) and a later override wins
  over an earlier one. With the server's rules, the plain TypeScript of `packages/webui-shared/src` gets 216 reports
  from 8 rules. `node:http` for `createServer` is reported by `nodeBuiltinImport`; `apiStabilityLeak` fires on nearly
  every exported layer.

## Reference files

| Topic                                    | File under `repos/effect/`                                                                                       |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `HttpApi` definition, handlers, errors   | `ai-docs/src/51_http-server/fixtures/api/*.ts`, `fixtures/server/Users/http.ts`, `fixtures/domain/UserErrors.ts` |
| Handler tests without a server           | `ai-docs/src/51_http-server/20_testing.ts`                                                                       |
| Entry point                              | `ai-docs/src/01_effect/06_running/20_layer-launch.ts`                                                            |
| SQL client, migrator, repository         | `ai-docs/src/40_sql/10_basics.ts`, `packages/effect/src/sql/Migrator.ts`                                         |
| CLI                                      | `ai-docs/src/70_cli/10_basics.ts`, `packages/effect/src/cli/Command.ts` (`runWith`, its test layer)              |
| HTTP server on Node, shutdown, upgrade   | `packages/platform/node/src/NodeHttpServer.ts`                                                                   |
| Static files                             | `packages/effect/src/http/HttpStaticServer.ts`                                                                   |
| WebSocket handler, event stream response | `packages/platform/node/test/GraphQLProtocol.test.ts`                                                            |
| Server-sent events                       | `packages/effect/src/encoding/Sse.ts`                                                                            |
| DevTools                                 | `packages/effect/src/devtools/DevTools.ts`                                                                       |
| Language service options                 | `node_modules/@effect/tsgo/README.md`                                                                            |

## Review Focus

- **A data directory of the Nitro server:** it opens with its rows intact, no migration replayed, and still opens
  with the Nitro server afterwards (Task 6, tests on the legacy fixtures; Task 10, the same through the build).
- **A stop with a page open:** an open `/ws` or stream must not hold the process: under 2 s, close code 1001, exit
  code 0, steps registered with `Shutdown.before` run first (Tasks 4, 8, 10).
- **The page instead of an answer:** an unknown `/api/*` path or a missing hashed asset must be a 404, never
  `index.html` (Task 5).
- **A build that only works in the repository:** the launcher runs from an empty folder outside it and requires
  nothing but Node builtins (Task 3).
- **A stored setting that became invalid:** that key falls back to its default, the other keys keep their values, and
  the Settings page can repair it (Task 7).

---

### Task 1: Shared runs under Node as it is

**Files:**

- Modify: every file of `packages/webui-shared/src/` that has a relative import (add the `.ts` extension)
- Modify: `packages/webui-shared/tsconfig.json` (`"erasableSyntaxOnly": true`)
- Test: `packages/webui-shared/src/node.test.ts`

**Interfaces:**

- Produces: `@llama-webui/shared` can be imported by `node` from its sources (the dev loop of Task 9 relies on it).

- [ ] **Step 1: Write the failing test**

```ts
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { expect, test } from 'vitest';

test('Node imports the package from its sources, without a build', () => {
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', "await import('@llama-webui/shared')"], {
    cwd: join(import.meta.dirname, '../../../app'),
    encoding: 'utf8',
  });
  expect(run.stderr).toBe('');
  expect(run.status).toBe(0);
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `LLAMA_WEBUI_TEST_BUILD=0 pnpm exec vitest run packages/webui-shared/src/node.test.ts`
Expected: FAIL, stderr holds `ERR_MODULE_NOT_FOUND` for `…/webui-shared/src/bench`.

- [ ] **Step 3: Add `.ts` to every relative import and export of `packages/webui-shared/src/`**, tests included, and
      set `erasableSyntaxOnly`.

- [ ] **Step 4: Run it to make sure it passes**, then `pnpm lint && pnpm check && pnpm test`.

- [ ] **Step 5: Commit**

```bash
git add packages/webui-shared
git commit -m "refactor(shared): Run under Node from the sources"
```

---

### Task 2: Database fixtures from the Nitro server

The old code must write them while it still runs in the tree.

**Files:**

- Create: `app/server/db/fixtures/legacy-v17.sqlite`, `app/server/db/fixtures/legacy-v16.sqlite`
- Create: `app/server/db/fixtures/README.md` (what each file holds, the commit that wrote it)
- Temporary: `app/server/lib/db/fixtures.gen.test.ts` (deleted in Step 3)

**Interfaces:**

- Produces, for Tasks 6 and 10:
  - `legacy-v17.sqlite`: opened by `openDb()` of `app/server/lib/db/open.ts` (schema version 17), then filled through
    the old repositories with settings `{ port: 8123, hiddenGpus: ['GPU-1'] }`, two profiles named `A` and `B`, and
    one conversation on profile `B` with two messages.
  - `legacy-v16.sqlite`: `runMigrations(db, 16)`, then filled exactly as the test
    `rebuilding profiles keeps their ids and every link to them (#38)` of `app/server/lib/db/migrations.test.ts` fills
    its old schema, plus the rows of the other test of that file.
  - Each file is one self-contained database: `PRAGMA wal_checkpoint(TRUNCATE)` then close, no `-wal` or `-shm` next
    to it.

- [ ] **Step 1: Write `fixtures.gen.test.ts`**, one test per file that writes the fixture as described and ends by
      reopening it read-only to assert `SELECT version FROM schema_version` (17, then 16).

- [ ] **Step 2: Run it**

Run: `LLAMA_WEBUI_TEST_BUILD=0 pnpm exec vitest run app/server/lib/db/fixtures.gen.test.ts`
Expected: 2 passed; `ls app/server/db/fixtures` lists the two `.sqlite` files and nothing ending in `-wal` or `-shm`;
`git check-ignore app/server/db/fixtures/legacy-v17.sqlite` prints nothing.

- [ ] **Step 3: Delete `fixtures.gen.test.ts`, write the README, check and commit**

Run: `pnpm lint && pnpm check && pnpm test`

```bash
git add app/server/db/fixtures
git commit -m "test(db): Keep two databases written by the Nitro server as fixtures"
```

---

### Task 3: The switch

The Nitro server leaves the build; an Effect server answers `GET /api/health` and serves the UI; the web runs on the
derived client and shows a waiting page for what is not ported. Until Task 9, `pnpm dev` serves the UI without an API.

**Files:**

- Move (`git mv`): `app/server/` to `app/server-legacy/`, except `app/server/db/fixtures/`
- Delete: `app/build/apiTypes.ts`
- Modify: `biome.jsonc` (`"!!app/server-legacy"` next to `"!!repos"`; drop the entries of the generated files that
  left), `vitest.config.ts` (`globalSetup: ['app/server/testing/build.ts']`), `app/package.json` (remove `nitro`;
  `"build": "vite build && node build/server.ts"`), `packages/webui-shared/package.json` (`"effect": "catalog:"`),
  `pnpm-lock.yaml`, `app/vite.config.ts` (no Nitro, `build.outDir: '.output/public'`; its `.env` loading, imported
  from the old server, returns in Task 9), `app/build/licenses.ts`, `scripts/prepack.ts` and
  `scripts/package.test.ts` (`server/nvml-worker.mjs` leaves their file lists until E4), `CLAUDE.md`
- Create: `tsconfig.effect.json`, `app/server/tsconfig.json`; modify `packages/webui-shared/tsconfig.json`
- Create: `packages/webui-shared/src/api/HealthApi.ts`, `packages/webui-shared/src/api/Api.ts` (exported by
  `index.ts`)
- Create: `app/server/main.ts`, `app/server/App.ts`, `app/server/config/AppConfig.ts`,
  `app/server/config/AppInfo.ts`, `app/server/health/http.ts`, `app/server/http/HttpLive.ts`,
  `app/server/http/Static.ts`
- Create: `app/build/server.ts`; rewrite `app/bin/llama-webui.ts` as `#!/usr/bin/env node` + `import
  './server/index.mjs'`
- Create: `app/server/testing/build.ts`, `app/server/testing/launch.ts`, `app/server/testing/tempDir.ts`
- Rewrite: `app/src/lib/api.ts`, `app/src/lib/api.test.ts`, `app/src/lib/health.ts`
- Modify: `app/src/main.tsx`, `app/src/app/router.tsx`, `app/src/app/routes.ts`, `app/src/app/StatusBar.tsx`,
  `app/src/lib/theme.ts`, `app/src/features/_placeholder/PlaceholderPage.tsx`, `app/tsconfig.json`
- Test: `app/server/health/http.test.ts`, `app/server/config/AppInfo.test.ts`, `app/server/build.test.ts`,
  `app/build/licenses.test.ts` (kept)

**Interfaces:**

- Effect diagnostics, one configuration for the two projects that hold Effect code (user: the shared package is
  checked too). `tsconfig.effect.json` (root) extends `tsconfig.base.json` and holds the plugin block of
  `app/server-legacy/tsconfig.json`, changed as below. `app/server/tsconfig.json` (Node types,
  `"erasableSyntaxOnly": true`, `"include": ["."]`) and `packages/webui-shared/tsconfig.json` extend it and declare no
  plugin of their own.

```jsonc
// removed: "ignoreEffectWarningsInTscExitCode" and its comment
"diagnosticSeverity": {
  // …the existing map, with one change: nearly every Effect module beyond the core is unstable (see unstableApiUsage)
  "apiStabilityLeak": "off"
},
// Globs are relative to this file; a later entry wins over an earlier one.
"overrides": [
  {
    // Code that drives the build from outside (child process, fetch, timers): the platform is its subject.
    "include": [
      "**/testing/**/*.ts",
      "**/contract/**/*.ts",
      "**/lifecycle.test.ts",
      "**/build.test.ts",
      "**/dev.test.ts",
      "**/runApp.test.ts"
    ],
    "options": {
      "diagnosticSeverity": {
        "nodeBuiltinImport": "off",
        "asyncFunction": "off",
        "newPromise": "off",
        "globalFetch": "off",
        "globalTimers": "off",
        "globalDate": "off",
        "globalConsole": "off",
        "globalJson": "off",
        "globalRandom": "off",
        "processEnv": "off",
        "cryptoRandomUUID": "off"
      }
    }
  },
  {
    // The shared package's pure logic stays plain TypeScript (spec): not asked to be written with Effect.
    "include": ["packages/webui-shared/src/**/*.ts"],
    "options": {
      "diagnosticSeverity": {
        "strictBooleanExpressions": "off",
        "preferEffectArray": "off",
        "preferEffectString": "off",
        "preferEffectRecord": "off",
        "missingPipeableSignature": "off",
        "missedPipeableOpportunity": "off",
        "nodeBuiltinImport": "off",
        "asyncFunction": "off",
        "globalJson": "off"
      }
    }
  },
  {
    // Its Effect modules follow the server's rules. Each milestone adds the modules it moves to Schema.
    "include": ["packages/webui-shared/src/api/**/*.ts"],
    "options": {
      "diagnosticSeverity": {
        "strictBooleanExpressions": "warning",
        "preferEffectArray": "warning",
        "preferEffectString": "warning",
        "preferEffectRecord": "warning",
        "missingPipeableSignature": "warning",
        "missedPipeableOpportunity": "warning",
        "nodeBuiltinImport": "warning",
        "asyncFunction": "warning",
        "globalJson": "warning"
      }
    }
  }
]
```

No other file or rule is added to the first two entries without asking. Tasks 7 and 8 add
`packages/webui-shared/src/settings.ts` and `packages/webui-shared/src/ws.ts` to the third.

- `CLAUDE.md`, under the `# llama-webui` title, a note: on `poc/effect` the server is the Effect server of
  `app/server/`; the sections below that describe Nitro, `lib/`, `routes/` and `api.gen.ts` describe
  `app/server-legacy/`, a read-only reference; the plan of the current milestone wins where they disagree. The other
  sections are rewritten at E10.

- Produces, shared:

```ts
// api/HealthApi.ts
export const Health = Schema.Struct({
  ok: Schema.Literal(true),
  version: Schema.String,
  uptimeMs: Schema.Int,
  bootId: Schema.String,
});
export class HealthApi extends HttpApiGroup.make('health').add(
  HttpApiEndpoint.get('get', '/api/health', { success: Health }),
) {}
// api/Api.ts: every later milestone adds its group here
export class Api extends HttpApi.make('llama-webui').add(HealthApi) {}
```

Convention for every later endpoint: one `HttpApiGroup` per domain, named after it; the endpoint carries its full
path; a wire error is a `Schema.TaggedError` with an `httpApiStatus` and a `message: Schema.String` field, the
sentence shown to the user (the web switches on `_tag`, never on the text).

- Produces, server:

```ts
/** Where the app listens and keeps its data. */
export class AppConfig extends Context.Service<AppConfig, {
  readonly host: string; // LLAMA_WEBUI_HOST, default '127.0.0.1'
  readonly port: number; // LLAMA_WEBUI_PORT, default 7860
  readonly dataDir: string; // LLAMA_WEBUI_DATA_DIR, default: as `dataDir()` of app/server-legacy/lib/paths.ts
  readonly dev: boolean; // LLAMA_WEBUI_DEV=1, set by `pnpm dev` only
}>()(/* key */) {
  /** From the environment and the defaults. */
  static readonly layer: Layer.Layer<AppConfig, Config.ConfigError>;
}

/** What this process is: read by /api/health and the hello of /ws. */
export class AppInfo extends Context.Service<AppInfo, {
  readonly version: string; // 'dev' from source; `git describe --tags --always --dirty` at build, else package.json's
  readonly bootId: string; // a fresh opaque id per process start
  readonly uptimeMs: Effect.Effect<number>;
}>()(/* key */) { static readonly layer: Layer.Layer<AppInfo>; }

// App.ts: the whole application but its configuration; later tasks add their layers here.
export const App: Layer.Layer<never, unknown, AppConfig>;
// http/HttpLive.ts: routes + NodeHttpServer. Options: disableLogger, disableListenLog,
// gracefulShutdownTimeout '500 millis'. The services are built before the port is opened. Once it listens, one
// log line: `ready (<version>) on http://<host>:<port>`.
// http/Static.ts: the UI of `<folder of the server bundle>/../public`, index.html for any other GET; nothing in dev.
// main.ts, until Task 4: runMain(Layer.launch(App.pipe(Layer.provide(AppConfig.layer)))), with the teardown of
// "Facts verified".
```

- Produces, tests (`app/server/testing/launch.ts`, same contract as the old helper):

```ts
export const LAUNCHER: string; // app/.output/llama-webui.mjs
/** Starts the build like a user (no CI, TEST or NODE_ENV), waits for /api/health; `await using` stops it (SIGTERM). */
export function launch(o: { dataDir: string; port?: number; env?: Record<string, string> }): Promise<{
  base: string; port: number; proc: ChildProcess; exited: Promise<number | null>; [Symbol.asyncDispose](): Promise<void>;
}>;
```

- Produces, web (`app/src/lib/api.ts`):

```ts
/** A failed call that never reached the server. `message`: 'llama-webui server unreachable'. */
export class ApiUnreachable extends Error {
  readonly _tag = 'ApiUnreachable';
}
/**
 * One call of an API: resolves with the decoded reply, rejects with the endpoint's tagged error as the server sent
 * it, or with `ApiUnreachable`. `fetchImpl` replaces `fetch` in tests.
 */
export function makeCall<Id extends string, Groups extends HttpApiGroup.Constraint>(
  api: HttpApi.HttpApi<Id, Groups>,
  fetchImpl?: typeof fetch,
): <A, E>(
  f: (client: HttpApiClient.Client<Groups>) => Effect.Effect<A, E>,
  options?: { signal?: AbortSignal },
) => Promise<A>;
/** `call((api) => api.health.get())` */
export const call = makeCall(Api);
/** The `_tag` of what a call rejected with, if it has one. */
export function errorTag(error: unknown): string | undefined;
```

One `ManagedRuntime` (`FetchHttpClient.layer`) runs the calls. No `fetch('/api…')` elsewhere in the web.

- Web parking rule. The unported pages and stores stay where they are, untouched, importing names `api.ts` no longer
  exports: nothing reaches them once the router shows the waiting page, Biome does not report them and their tests
  keep passing (verified). `app/tsconfig.json` checks what the app loads: `"include"` becomes `["src/main.tsx",
  "src/*.d.ts", "src/**/*.test.ts", "src/**/*.test.tsx", "build", "vite.config.ts"]`, and `"exclude"` lists each test
  file through which `tsc` reaches a module that still calls the old client (expected: `src/lib/bench.test.ts`,
  `src/lib/props.test.ts`, `src/lib/tuning.test.ts`, and `src/features/profiles/draft.test.ts` if `tsc` reports
  through it). Vitest still runs those tests. A page comes back by being routed again at its milestone, which removes
  its tests from `"exclude"`.

- [ ] **Step 1: Move the old server and cut it loose.** `git mv`, the config changes of the list above (the new
      `tsconfig.json` and the `CLAUDE.md` note included), `pnpm install`. `pnpm lint` passes without reading
      `app/server-legacy/`.

- [ ] **Step 2: Write the failing tests**

| File                                                                                                                                          | Test                                                                    | Asserts                                                                                                                                                     |
| --------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `health/http.test.ts` (`HttpApiTest`, no server)                                                                                              | `health answers ok with the version, the uptime and the bootId`         | `ok === true`, `version === 'dev'`, `uptimeMs >= 0`, two calls give the same `bootId`                                                                       |
| `config/AppInfo.test.ts`                                                                                                                      | `version: dev when running from source`                                 | `version === 'dev'`                                                                                                                                         |
| `src/lib/api.test.ts` (a test `HttpApi` with one `GET /t/:id` that takes a query and fails with a tagged error, one `POST /t` with a payload) | `call() resolves with the decoded reply of the endpoint`                | value equals the stubbed JSON                                                                                                                               |
|                                                                                                                                               | `call() fills in the path, the query and the JSON payload`              | the stub saw `GET /t/7?q=a`, then `POST /t` with `content-type: application/json` and the body                                                              |
|                                                                                                                                               | `call() rejects with the tagged error of the endpoint`                  | `errorTag(e) === 'TestNotFound'`, `e.message` as sent                                                                                                       |
|                                                                                                                                               | `call() rejects with ApiUnreachable when fetch rejects`                 | `errorTag(e) === 'ApiUnreachable'`, message `llama-webui server unreachable`                                                                                |
|                                                                                                                                               | `call() passes its signal: an abort reaches fetch and rejects the call` | the stub's `init.signal.aborted === true`                                                                                                                   |
| `build.test.ts` (needs the build)                                                                                                             | `the launcher starts from an empty folder outside the repository`       | `.output` copied to a temp dir, started there with a temp cwd: `/api/health` is 200, `version !== 'dev'`, stdout holds `ready (`                            |
|                                                                                                                                               | `the server requires nothing but Node builtins`                         | every `import`/`require`/`import()` specifier of `llama-webui.mjs` and `server/*.mjs` is `isBuiltin()` (`node:module`) or a relative path to a shipped file |
|                                                                                                                                               | `the client imports no node:* module`                                   | no import specifier starting with `node:` under `public/assets`                                                                                             |
|                                                                                                                                               | `each page is a chunk of its own`                                       | the entry chunk named by `index.html` does not contain the text of `PlaceholderPage`                                                                        |
|                                                                                                                                               | `a deep URL gets the shell`                                             | `GET /settings` is 200, `text/html`, and every `/assets/…` it names is 200                                                                                  |
|                                                                                                                                               | `the licenses of the bundled code ship with the server`                 | `THIRD-PARTY-LICENSES.md` has a heading starting `## effect - 4.1.4` and one starting `## @effect/platform-node - 4.1.4`, each followed by text             |

- [ ] **Step 3: Run them to make sure they fail**

Run: `pnpm exec vitest run app/server app/src/lib/api.test.ts`
Expected: FAIL (no server, no build script).

- [ ] **Step 4: Shared and server.** `HealthApi`, `Api`; `AppConfig`, `AppInfo`, the health handlers
      (`HttpApiBuilder.group(Api, 'health', …)`), `Static`, `HttpLive`, `App`, `main.ts`.

- [ ] **Step 5: Build.** `app/build/server.ts`: after `vite build`, bundles `server/main.ts` into
      `.output/server/index.mjs` and `bin/llama-webui.ts` into `.output/llama-webui.mjs` (executable), with
      `LLAMA_WEBUI_VERSION` defined as today, `bufferutil` and `utf-8-validate` resolved to a stub that throws, then writes
      `THIRD-PARTY-LICENSES.md` from the modules Rolldown bundled (`licenses.ts` keeps `packageRoot`, `render`, the
      heading format `## <name> - <version> (<license>)` and their two tests).

- [ ] **Step 6: Web.**
  - `api.ts`, `health.ts` on `call`.
  - `routes.ts`: `MILESTONE_BY_PATH = { '/': 'E3', '/dashboard': 'E4', '/models': 'E6', '/profiles': 'E2', '/server':
    'E3', '/chat': 'E5', '/system': 'E4', '/topology': 'E4', '/logs': 'E3', '/bench': 'E7', '/tuning': 'E8',
    '/settings': 'E1' }`.
  - `router.tsx`: only the placeholder routes remain (`/setup` and `/chat/:id` included).
  - `PlaceholderPage`: card title `Not ported yet`, text `` `Back with milestone ${milestone} of the Effect server
    rewrite.` ``.
  - The shell, as a rule: every module still reachable from `main.tsx` drops its imports of unported stores and
    pages, and nothing else changes in it. Known cases: `main.tsx` keeps the theme and the WebSocket connection and
    loses the `start…Sync()` calls of unported domains; `StatusBar` loses the server badge (`@/lib/server`,
    `ServerStateBadge`); `theme.ts` loses its two settings calls until Task 7 (the theme stays a local preference
    meanwhile). Name every module changed under this rule in the task summary.
  - `app/tsconfig.json` as the parking rule says.

- [ ] **Step 7: Run everything**

Run: `pnpm lint && pnpm check && pnpm test`, then `pnpm check 2>&1 | grep -c 'effect('`
Expected: green, and `0`. A `tsc` error in a web module is settled by the shell rule (the module is reachable from
`main.tsx`) or by the parking rule (it is reached through a test file only); stop and report only for an error
neither rule covers, or for a Biome report on a parked file.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(server)!: Start the server from one Effect entry point, park the Nitro server"
```

---

### Task 4: Entry point: options, `.env`, port, exit

**Files:**

- Create: `app/server/config/Cli.ts`, `app/server/config/DotEnv.ts`, `app/server/http/Address.ts`,
  `app/server/runtime/Shutdown.ts`, `app/server/runtime/runApp.ts`, `app/server/testing/fixtures/slowStop.ts`,
  `app/server/testing/fixtures/fails.ts`
- Modify: `app/server/main.ts`, `app/server/config/AppConfig.ts`, `app/server/App.ts`, `app/server/testing/launch.ts`
  (passes `--host`, `--port`, `--data-dir`)
- Test: `app/server/config/Cli.test.ts`, `app/server/config/DotEnv.test.ts`, `app/server/runtime/Shutdown.test.ts`,
  `app/server/runtime/runApp.test.ts`, `app/server/lifecycle.test.ts`

**Interfaces:**

- Port from: `app/server-legacy/lib/cli.ts` (options, messages, the content of `helpText()`), `lib/env.ts`
  (`loadDotEnv` only), `lib/paths.ts`, `app/server-legacy/plugins/runtime.ts` and `app/bin/llama-webui.ts` at
  `6327201a3` (signals, port check and its message).
- Produces:

```ts
// config/Cli.ts
export interface CliFlags {
  readonly host: Option.Option<string>; // non-empty
  readonly port: Option.Option<number>; // integer from 1 to 65535
  readonly dataDir: Option.Option<string>; // non-empty
  readonly envOverride: boolean;
}
/** The `llama-webui` command on the arguments of the process: parses them, then runs `start` with the flags.
 * `--help`/`-h` and `--version` print and end; a usage error prints the help, then the error, and fails. */
export const cli: <E, R>(
  start: (flags: CliFlags) => Effect.Effect<void, E, R>,
) => Effect.Effect<void, E | CliError.CliError, R | Command.Environment>;
/** The same on given arguments (tests). */
export const cliWith: <E, R>(
  start: (flags: CliFlags) => Effect.Effect<void, E, R>,
) => (args: ReadonlyArray<string>) => Effect.Effect<void, E | CliError.CliError, R | Command.Environment>;

// config/AppConfig.ts, added
/** A flag wins over its variable, a variable over the default. */
static readonly layerWith: (flags: CliFlags) => Layer.Layer<AppConfig, Config.ConfigError>;

// config/DotEnv.ts
/** `.env` text applied to `env`: fills what is missing; with override (the option, or LLAMA_WEBUI_ENV_OVERRIDE=1|true
 * in `env` or in the file) the file wins. `parseEnv` of `node:util`: no `$VAR` expansion. */
export function applyDotEnv(env: NodeJS.ProcessEnv, text: string, options?: { override?: boolean }): void;
/** Applies `.env` of the current folder to the environment of the process; no file, nothing to do. */
export const loadDotEnv: (options: { readonly override: boolean }) => Effect.Effect<void, PlatformError, FileSystem.FileSystem>;

// http/Address.ts
export class AddressInUse extends Schema.TaggedError<…>()('AddressInUse', { message: Schema.String }) {}
/** Fails when nothing can listen on the configured address. `message`: `cannot listen on <host>:<port>: the port
 * is already in use` (or the system's reason). */
export const assertFree: Effect.Effect<void, AddressInUse, AppConfig>;

// runtime/Shutdown.ts
/** Steps that must run while clients are still connected. */
export class Shutdown extends Context.Service<Shutdown, {
  /** Registers a step: it runs when the app stops, before the HTTP server stops serving; last registered, first run. */
  readonly before: (step: Effect.Effect<void>) => Effect.Effect<void>;
}>()(/* key */) {
  static readonly layer: Layer.Layer<Shutdown>;
  /** The outermost layer of `App`: its finalizer runs the steps. */
  static readonly layerRunner: Layer.Layer<never, never, Shutdown>;
}

// runtime/runApp.ts
/** Runs a program as the process: exit 0 when it ends or on SIGINT/SIGTERM once undone; exit 1 on a failure, with
 * `llama-webui: <message>` on stderr for a tagged error that has a message, the pretty cause otherwise; a second
 * signal while stopping exits at once, as the Nitro server did. */
export function runApp(program: Effect.Effect<void, unknown>): void;
```

- `main.ts`, the order is the point (the address is checked before anything touches the data directory, `.env` is
  applied before the configuration is read):

```ts
const start = (flags: CliFlags) =>
  loadDotEnv({ override: flags.envOverride }).pipe(
    Effect.andThen(Effect.andThen(assertFree, Layer.launch(App)).pipe(Effect.provide(AppConfig.layerWith(flags)))),
  );
runApp(cli(start).pipe(Effect.provide(NodeServices.layer)));
```

- The built-in flags are reduced to help and version (`CliConfig.layer({ builtIns: [GlobalFlag.Help,
  GlobalFlag.Version] })`). The help keeps what `helpText()` says, in the layout of `effect/cli`: each flag names its
  variable (`env: LLAMA_WEBUI_HOST`…), the description keeps the three ways of running and the Hugging Face and proxy
  variables.

- [ ] **Step 1: Write the failing tests**

`Cli.test.ts` runs `cliWith(start)(args)` where `start` resolves `AppConfig.layerWith(flags)` under
`ConfigProvider.fromEnv({ env })` and keeps the result; output goes to a test `Stdio`.

| File                                             | Tests                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DotEnv.test.ts`                                 | the six `loadDotEnv: …` tests of `app/server-legacy/lib/env.test.ts`, same names with `applyDotEnv`, same values                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `Cli.test.ts`                                    | `defaults without flag or env` (`127.0.0.1`, 7860); `environment variables`; `a flag overrides the env, --opt=val form accepted`; `an empty variable is ignored`; `--help and -h print the help and start nothing`; `invalid port, flag or env` (`0`, `70000`, `abc`, `1.5` each refused, `start` not run or failed); `unknown option, missing value, positional, empty value are refused` (`--nope`, `--host`, `extra`, `--host ""`, `--data-dir=`); `--env-override is accepted and reaches start`; `the help names the installed command and the pnpm scripts`; `the help names each option with its variable` (the four flags, `LLAMA_WEBUI_HOST`, `LLAMA_WEBUI_PORT`, `LLAMA_WEBUI_DATA_DIR`, `LLAMA_WEBUI_ENV_OVERRIDE`); `the built-in flags are help and version only` (`--wizard` refused) |
| `Shutdown.test.ts` (`it.effect`)                 | `steps run when the scope closes, last registered first`; `a step that fails does not stop the next ones`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `runApp.test.ts` (runs the fixtures with `node`) | `SIGTERM undoes the app and exits 0` (`slowStop.ts` with a 100 ms finalizer prints `undone`); `a second signal while stopping exits at once` (`slowStop.ts` with a 10 s finalizer: two SIGTERM 200 ms apart, exit in under 1 s); `a failure exits 1 with its message` (`fails.ts` fails with a tagged error: stderr holds `llama-webui: ` and the message)                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `lifecycle.test.ts` (needs the build)            | `a second instance on a taken port exits 1 and names it` (stderr holds `cannot listen on 127.0.0.1:<port>: the port is already in use`); `a second instance on the same port and data dir leaves the first one` (both from `app/server-legacy/lifecycle.test.ts`); `a variable of .env sets the port, the environment wins over it`; `--env-override lets .env win over the environment`                                                                                                                                                                                                                                                                                                                                                                                                            |

- [ ] **Step 2: Run them to make sure they fail**

Run: `pnpm exec vitest run app/server/config app/server/runtime app/server/lifecycle.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**, with `Shutdown.layer` under every service and `Shutdown.layerRunner` outermost in `App`
      (the shape of "Facts verified").

- [ ] **Step 4: Run the tests, then everything**

Run: `pnpm lint && pnpm check && pnpm test`

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(server): Read the options, check the port and stop in order"
```

---

### Task 5: HTTP edge: guard, unknown routes, the UI's cache, streams

**Files:**

- Create: `app/server/http/Guard.ts`, `app/server/http/Sse.ts`; `packages/webui-shared/src/api/errors.ts`
- Modify: `app/server/http/Static.ts`, `app/server/http/HttpLive.ts`
- Test: `app/server/http/Guard.test.ts`, `app/server/http/Static.test.ts`, `app/server/http/HttpLive.test.ts`,
  `app/server/http/Sse.test.ts`

**Interfaces:**

- Port from: `app/server-legacy/lib/security.ts`, `middleware/01.guard.ts`, `middleware/02.cache.ts`,
  `lib/chat/sse.ts` (headers and ping), and the cache header values asserted by
  `app/server-legacy/lifecycle.test.ts`.
- Produces:

```ts
// shared, api/errors.ts
export class RequestRefused extends Schema.TaggedError<…>()('RequestRefused', { message: Schema.String }) {}
export class RouteNotFound extends Schema.TaggedError<…>()('RouteNotFound', { message: Schema.String }, { httpApiStatus: 404 }) {}

// Guard.ts
/** Why a request to /api/* or /ws is refused, if it is: status and message of the Nitro server's guard. */
export function refusal(request: {
  readonly method: string;
  readonly headers: Readonly<Record<string, string | undefined>>;
}): { readonly status: number; readonly message: string } | undefined;
/** The guard as a middleware of the whole server: it judges /api/* and /ws only, and answers a refusal as JSON
 * (`RequestRefused`) with `Connection: close` on an upgrade. */
export const guard: /* the middleware `HttpRouter.serve` takes */;

// Sse.ts
/** A `text/event-stream` response fed by `events`: a `: ping` comment every `pingInterval` (15 s by default) while
 * nothing else is sent, the headers of the Nitro server's stream, ended when `events` ends. */
export function sseResponse<E, R>(
  events: Stream.Stream<{ readonly event?: string; readonly data: string }, E, R>,
  options?: { readonly pingInterval?: Duration.Input },
): Effect.Effect<HttpServerResponse.HttpServerResponse, never, R>;
```

- Behaviour:
  - Any `/api/*` request that no endpoint matches answers 404 with `RouteNotFound` (`message: 'Unknown route'`) as
    JSON.
  - `/assets/*` is served from `public/assets` with the immutable cache header of the Nitro server; a missing file
    is a 404. Any other `GET` is a file of `public/` when there is one, else `index.html`, both `no-cache`. API replies
    carry no cache header.
  - A defect in a handler answers 500 without its message and is logged.

- [ ] **Step 1: Write the failing tests**

| File                                                                                     | Tests                                                                                                                                                                                                                                                                                                                             |
| ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Guard.test.ts`                                                                          | the five `guard: …` tests of `app/server-legacy/lib/security.test.ts`, same names and inputs, on `refusal()`                                                                                                                                                                                                                      |
| `HttpLive.test.ts` (real server on a free port, `NodeHttpServer.layerTest`)              | `an unknown /api path is a 404 RouteNotFound, not the page`; `a refused request is answered as JSON, and the UI is not guarded` (`GET /` with a domain `Host` is 200, `GET /api/health` with it is refused); `a defect answers 500 without its message` (a test route that dies with `secret`: status 500, body without `secret`) |
| `Static.test.ts` (a temp `public/` with `index.html`, `favicon.svg`, `assets/a-1234.js`) | `pages are revalidated, hashed assets are immutable, the API sets no cache header`; `a missing asset is a 404, not the page`; `a file of the root is served as itself`                                                                                                                                                            |
| `Sse.test.ts`                                                                            | `events arrive as they are produced, then the response ends`; `a ping comment is sent while no event comes` (`pingInterval: '50 millis'`); `a client that goes away interrupts the source` (its finalizer ran); `a Shutdown.before step that ends the source lets the client read the last event and a clean end`                 |

- [ ] **Step 2: Run them to make sure they fail**

Run: `LLAMA_WEBUI_TEST_BUILD=0 pnpm exec vitest run app/server/http`

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Run the tests, then** `pnpm lint && pnpm check && pnpm test`.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(server): Guard the API, answer unknown routes and cache the UI"
```

---

### Task 6: Database: client, migrations, the Nitro server's databases

**Files:**

- Create: `app/server/db/Db.ts`, `app/server/db/migrations.ts`, `app/server/db/LegacyBridge.ts`
- Modify: `app/server/App.ts`
- Test: `app/server/db/Db.test.ts`

**Interfaces:**

- Port from: `app/server-legacy/lib/db/migrations.ts` (17 entries, the SQL text unchanged), `lib/db/open.ts`.
- Produces:

```ts
/** The 17 migrations of the Nitro server, one for one, keyed `0001_<name>` … `0017_<name>` for `Migrator.fromRecord`.
 * Each runs its statements one at a time. */
export const MIGRATIONS: Record<string, Effect.Effect<void, SqlError, SqlClient.SqlClient>>;

/** `<dataDir>/llama-webui.sqlite`, opened and brought up to date. */
export const layer: Layer.Layer<SqlClient.SqlClient, /* errors */, AppConfig>;
/** The same on a given file (`:memory:` in tests). */
export const layerAt: (filename: string) => Layer.Layer<SqlClient.SqlClient, /* errors */>;
```

- What opening does, in this order (our own layer around `SqliteClient.layer` and `SqliteMigrator.run`, so the order
  is ours):
  1. Create the data directory, open the file (WAL).
  2. `PRAGMA foreign_keys = OFF`: the client leaves them on, migration 17 rebuilds `profiles`, and the pragma does
     nothing inside the migrator's transaction.
  3. Bridge: when `schema_version` exists and `effect_sql_migrations` does not, create that table (the DDL of "Facts
     verified") and record migrations 1 to `schema_version.version` as already run.
  4. Run the migrator. Migration 17 keeps the check of `runRebuild`: only a foreign key violation that was not there
     before aborts it.
  5. `PRAGMA foreign_keys = ON`.
  6. Write the last migration id into `schema_version` (created if missing): the database still opens with the Nitro
     server.

- [ ] **Step 1: Write the failing tests** (`it.effect`; each copies a fixture to a temp folder before opening it)

| Test                                                                                            | Asserts                                                                                                                                                        |
| ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `a new database gets the schema of the Nitro server`                                            | `SELECT type, name, sql FROM sqlite_schema` without `effect_sql_migrations`, sorted by name, equals the same query on `legacy-v17.sqlite`                      |
| `a database of the Nitro server is recognised: nothing is replayed and its rows are intact`     | on `legacy-v17.sqlite`: 17 rows in `effect_sql_migrations`; the rows of `settings`, `profiles`, `conversations` and `messages` equal those read before opening |
| `an older database is brought up to date: profiles keep their ids and every link to them (#38)` | on `legacy-v16.sqlite`: the assertions of the old test of that name                                                                                            |
| the other test of `app/server-legacy/lib/db/migrations.test.ts`, same name                      | its assertions                                                                                                                                                 |
| `foreign keys are on once the database is open`                                                 | `PRAGMA foreign_keys` is 1, and an insert that breaks a link fails                                                                                             |
| `the database still opens with the Nitro server`                                                | new database: `SELECT version FROM schema_version` is 17                                                                                                       |
| `opening twice runs nothing the second time`                                                    | same file opened again: row counts of `effect_sql_migrations` and `sqlite_schema` unchanged                                                                    |
| `a number bound to an INTEGER column is stored as an integer, a boolean as 1 or 0`              | a temp table `(n INTEGER, b INTEGER, u)`: `3`, `true`, `3` inserted through `SqlClient` give `typeof()` `integer`, `integer`, `real`                           |

- [ ] **Step 2: Run them to make sure they fail**

Run: `LLAMA_WEBUI_TEST_BUILD=0 pnpm exec vitest run app/server/db`

- [ ] **Step 3: Implement.** Do not wrap the client to change how it binds: a repository that feeds a number to a
      JSON function or an untyped column writes `CAST(… AS INTEGER)` in its SQL (a rule for `conventions.md`, Task 11).

- [ ] **Step 4: Run the tests, then** `pnpm lint && pnpm check && pnpm test`.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(db): Open the database through SqlClient and recognise the Nitro server's"
```

---

### Task 7: Settings

**Files:**

- Rewrite: `packages/webui-shared/src/settings.ts` (Schema, no zod; added to the third override of
  `tsconfig.effect.json`)
- Create: `packages/webui-shared/src/api/SettingsApi.ts` (added to `Api`), `app/server/settings/SettingsRepo.ts`,
  `app/server/settings/http.ts`
- Modify: `app/server/App.ts`, `app/src/lib/settings.ts`, `app/src/lib/theme.ts`, `app/src/app/router.tsx`,
  `app/src/app/routes.ts` (`'/settings'` leaves `MILESTONE_BY_PATH`), `app/src/features/settings/*`
- Test: `packages/webui-shared/src/settings.test.ts`, `app/server/settings/SettingsRepo.test.ts`,
  `app/server/settings/http.test.ts`

**Interfaces:**

- Port from: `git show 6327201a3:packages/webui-shared/src/settings.ts` (every field, default, bound and message),
  `app/server-legacy/lib/db/settings.ts`, `app/server-legacy/routes/api/settings.*.ts`.
- Produces:

```ts
// shared
export const ENV_NAME: RegExp; // unchanged
export const Settings: Schema.Struct<…>; // same fields, defaults, bounds and messages as the zod schema
export type Settings = typeof Settings.Type;
export type ThemeMode = Settings['theme'];
export const DEFAULT_SETTINGS: Settings;
export class SettingsInvalid extends Schema.TaggedError<…>()('SettingsInvalid', {
  message: Schema.String, // 'Invalid settings'
  issues: Schema.Array(Schema.Struct({ path: Schema.Array(Schema.String), message: Schema.String })),
}, { httpApiStatus: 400 }) {}
export class SettingsApi extends HttpApiGroup.make('settings').add(
  HttpApiEndpoint.get('get', '/api/settings', { success: Settings }),
  HttpApiEndpoint.patch('patch', '/api/settings', {
    payload: Schema.Record(Schema.String, Schema.Unknown), // validated by the repository, for its field errors
    success: Settings,
    error: SettingsInvalid,
  }),
) {}

// server
export class SettingsRepo extends Context.Service<SettingsRepo, {
  /** Current settings; a stored value that is unreadable or no longer valid falls back to its default (logged). */
  readonly get: Effect.Effect<Settings>;
  /** Validates the merge, then writes the patched keys. Objects merge field by field (`collectors`), except `env`,
   * replaced as a whole. A key that is not a setting is ignored. */
  readonly patch: (partial: Readonly<Record<string, unknown>>) => Effect.Effect<Settings, SettingsInvalid>;
}>()(/* key */) { static readonly layer: Layer.Layer<SettingsRepo, never, SqlClient.SqlClient>; }
```

The monitor's `warning` of the old `PATCH` reply returns with E4. Other shared modules that still import zod keep
it until their milestone.

- [ ] **Step 1: Write the failing tests**

| File                                           | Tests                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `shared/settings.test.ts`                      | `the defaults are those of the Nitro server` (`DEFAULT_SETTINGS` equals the literal: `binary: 'llama-server'`, `host: '127.0.0.1'`, `port: 8080`, `modelsDir: '~/models'`, `pollIntervalMs: 1000`, `historySeconds: 300`, `hiddenGpus: []`, `defaultProfileId: null`, `llamaTuiImportDismissed: false`, `onboardingDone: false`, `collectors: { nvml: true, system: true, disk: true }`, `theme: 'system'`, `env: {}`); `each bound keeps its message` (`port: 0` → `Port between 1 and 65535`, `port: 1.5` → `Expected an integer`, `port: 'a'` → `Expected a number`, `binary: ''` → `Required`, `pollIntervalMs: 10` → `Between 250 and 60000 ms`, `historySeconds: 5` → `Between 30 and 1800 s`, `env: { '1A': 'x' }` → `invalid variable name “1A”`) |
| `SettingsRepo.test.ts` (`layerAt(':memory:')`) | the four `settings: …` tests of `app/server-legacy/lib/db/settings.test.ts`, same names; `a key that is not a setting is ignored`; `a patch that is invalid writes nothing and names the field` (`{ port: 70000, theme: 'dark' }` → `SettingsInvalid` with `issues: [{ path: ['port'], message: 'Port between 1 and 65535' }]`, and `get` still gives `theme: 'system'`)                                                                                                                                                                                                                                                                                                                                                                                  |
| `http.test.ts` (`HttpApiTest`)                 | `GET gives the settings, PATCH the settings after the patch`; `PATCH with an invalid field fails with SettingsInvalid`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

- [ ] **Step 2: Run them to make sure they fail**

Run: `LLAMA_WEBUI_TEST_BUILD=0 pnpm exec vitest run packages/webui-shared/src/settings.test.ts app/server/settings`

- [ ] **Step 3: Implement shared and server.**

- [ ] **Step 4: Web.** `useSettingsEditor` on `call`: a `SettingsInvalid` (`errorTag`) fills the field errors from
      `issues[].path[0]`, any other error is a toast of its `message`. `theme.ts` reads and saves the theme again.
      `/settings` is routed to `SettingsPage`. A part of the page fed by an endpoint that is not ported (`GET
  /api/system/info`, the GPU list of the monitor) shows the `Not ported yet` line with its milestone (E4) instead;
      name those parts in the task summary.

- [ ] **Step 5: Run everything**

Run: `pnpm lint && pnpm check && pnpm test`

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(settings): Serve the settings from the Effect server"
```

---

### Task 8: `/ws`

**Files:**

- Rewrite: `packages/webui-shared/src/ws.ts` (added to the third override of `tsconfig.effect.json`)
- Create: `app/server/ws/WsHub.ts`
- Modify: `app/server/http/HttpLive.ts` (the route; `websocket: { maxPayload: 4096 }` on `NodeHttpServer`),
  `app/server/App.ts`, `app/src/lib/ws.ts`
- Test: `app/server/ws/WsHub.test.ts`, `packages/webui-shared/src/ws.test.ts`

**Interfaces:**

- Port from: `app/server-legacy/lib/ws/hub.ts`, `app/server-legacy/routes/ws.ts`.
- Produces:

```ts
// shared: the push channel, one member per message; each later milestone adds its own
export const WsHello = Schema.Struct({ type: Schema.Literal('hello'), payload: Schema.Struct({ serverTime: Schema.Int, bootId: Schema.String }) });
export const WsPing = Schema.Struct({ type: Schema.Literal('ping') });
export const WsPong = Schema.Struct({ type: Schema.Literal('pong') });
export const WsMessage = Schema.Union([WsHello, WsPing, WsPong]);
export type WsMessage = typeof WsMessage.Type;

// server
export class WsHub extends Context.Service<WsHub, {
  /** Sends a message to every connected client. */
  readonly publish: (message: WsMessage) => Effect.Effect<void>;
  readonly size: Effect.Effect<number>;
}>()(/* key */) {
  static readonly layer: Layer.Layer<WsHub, never, AppInfo>; // ping every 15 s
  static readonly layerWith: (options: { readonly pingInterval: Duration.Input }) => Layer.Layer<WsHub, never, AppInfo>;
  /** `GET /ws`: the upgrade, then one fiber per client. */
  static readonly route: /* a route layer for HttpLive */;
}
```

- Behaviour: broadcasts go through a `PubSub`, each client subscribes for the life of its connection. On connect the
  client gets `hello`. Every interval it gets `ping`; `pong` resets its count; after 2 pings without a `pong` it is
  closed with code 4000. A client `ping` is answered with `pong`. Text that is not a JSON object is ignored. `/ws`
  goes through the guard; without an upgrade it answers 426. The 1001 at shutdown is `NodeHttpServer`'s.

- [ ] **Step 1: Write the failing tests** (real server on a free port, the global `WebSocket` as client,
      `layerWith({ pingInterval: '50 millis' })` where pings matter)

| Test                                                                | Asserts                                                                           |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `a client gets hello with the server time and the bootId`           | first message decodes as `WsHello`, `bootId` is `AppInfo`'s                       |
| `a published message reaches every client`                          | two clients both receive it, `size` is 2                                          |
| `a client ping is answered with pong`                               |                                                                                   |
| `a client that misses 2 pings is closed with 4000, a pong keeps it` | one silent client closed with 4000 while one that answers stays open              |
| `text that is not a JSON object is ignored`                         | `null`, `3`, `[]`, `{` sent: the connection stays open and still answers a ping   |
| `a message over 4096 bytes closes the connection with 1009`         |                                                                                   |
| `the upgrade goes through the guard`                                | an `Origin` of another site: the connection fails, `size` stays 0                 |
| `/ws without an upgrade is a 426`                                   | plain `GET /ws`                                                                   |
| `closing the app sends 1001 after the Shutdown.before steps`        | a step publishes a message: the client receives it, then its close with code 1001 |
| `shared/ws.test.ts`: `a message of an unknown type does not decode` | `Schema.decodeUnknownOption(WsMessage)({ type: 'snapshot' })` is none             |

- [ ] **Step 2: Run them to make sure they fail**

Run: `LLAMA_WEBUI_TEST_BUILD=0 pnpm exec vitest run app/server/ws packages/webui-shared/src/ws.test.ts`

- [ ] **Step 3: Implement the hub and the route** (reader before the first write: "Facts verified").

- [ ] **Step 4: Web.** `lib/ws.ts` decodes each frame with `WsMessage` and drops what does not decode; `onWs` and the
      reconnect are unchanged.

- [ ] **Step 5: Run everything, commit**

Run: `pnpm lint && pnpm check && pnpm test`

```bash
git add -A
git commit -m "feat(ws): Serve /ws from a PubSub hub"
```

---

### Task 9: Dev loop and DevTools

**Files:**

- Create: `app/build/devServer.ts` (Vite plugin), `app/server/testing/devCopy.ts`
- Modify: `app/vite.config.ts`, `app/server/App.ts`, `app/server/config/AppConfig.ts`
- Test: `app/server/dev.test.ts`

**Interfaces:**

- Port from: `app/server-legacy/dev.test.ts` (the copy of `app/` under `.cache/`, how it starts and stops
  `pnpm dev`).
- Produces: `pnpm dev` (`vite dev` in `app/`) is the whole dev loop.
  - `vite.config.ts` applies `.env` with `applyDotEnv` (the environment wins), as the production entry does.
  - The plugin picks a free loopback port, starts `node --watch server/main.ts --host 127.0.0.1 --port <that port>`
    with `LLAMA_WEBUI_DEV=1`, and proxies `/api` and `/ws` (WebSocket included) to it. Vite keeps the public address
    (`LLAMA_WEBUI_HOST`, `LLAMA_WEBUI_PORT`, 7860 by default).
  - Saving a file the server imports (`app/server/`, `packages/`) restarts the server: a new `bootId`. Saving under
    `app/src/` is HMR only.
  - Stopping Vite (SIGINT, SIGTERM) stops the server child with SIGTERM and waits for it; a second SIGINT kills it.
  - In dev, `App` adds `DevTools.layer(url)`, `url` from `LLAMA_WEBUI_DEVTOOLS_URL`, `ws://localhost:34437` by default.
    The production build never adds it.
  - A server file that does not run under type stripping is fixed in the file. Only a dependency that cannot run from
    source would justify a Rolldown watch build: stop and report before building one.

- [ ] **Step 1: Write the failing tests** (on a copy of `app/`, free ports)

| Test                                                        | Asserts                                                                                                                                |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `saving a server file restarts the server`                  | `bootId` of `/api/health` through Vite's port changes after a comment is appended to `server/health/http.ts`                           |
| `saving a web file keeps the server`                        | same `bootId` after a comment is appended to `src/main.tsx`                                                                            |
| `one SIGINT stops vite dev and the server`                  | both pids gone, in under 5 s                                                                                                           |
| `one SIGINT with a page open (/ws) stops at once`           | a client connected through Vite's port: closed, both pids gone in under 2 s                                                            |
| `two quick SIGINTs still stop the server`                   |                                                                                                                                        |
| `dev reads .env, the environment wins over it`              | `.env` sets `LLAMA_WEBUI_PORT`: Vite listens there; set in the environment too: the environment's port                                 |
| `in dev the server connects to the Effect DevTools address` | a `node:http` server on a free port that counts `upgrade` requests, `LLAMA_WEBUI_DEVTOOLS_URL` pointing to it: at least one within 5 s |

- [ ] **Step 2: Run them to make sure they fail**

Run: `LLAMA_WEBUI_TEST_BUILD=0 pnpm exec vitest run app/server/dev.test.ts`

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Run everything, commit**

Run: `pnpm lint && pnpm check && pnpm test`

```bash
git add -A
git commit -m "feat(dev): Run the Effect server under vite dev, with the DevTools"
```

---

### Task 10: Contract and lifecycle on the build

**Files:**

- Create: `app/server/contract/cases.ts`, `app/server/contract/wire.ts`, `app/server/contract/contract.test.ts`,
  `app/server/contract/golden.json` (generated; ignored by Biome with `!` like the old one)
- Modify: `app/server/lifecycle.test.ts`, `scripts/smoke.ts`

**Interfaces:**

- Port from: `app/server-legacy/lib/contract/` (how a case is replayed, how a reply is normalised, `UPDATE_GOLDEN=1`),
  `app/server-legacy/lifecycle.test.ts`.
- Produces: the contract suite every later milestone extends: one or more cases per endpoint of `Api`, replayed over
  HTTP against the build started by `launch()`, each reply (status, the headers the old golden kept, body) compared
  to `golden.json`. Normalised before comparing: asset hashes (`<hash>`), `uptimeMs`, `bootId`, `version`.
  The endpoint list comes from the definition (`HttpApi.reflect(Api, …)`).
- Cases of E1: health; settings read; a valid patch; an invalid patch; a write without JSON; another site's `Origin`;
  a domain `Host`; an unknown `/api` path; `/ws` without an upgrade; `/`; a deep URL; a hashed asset; a missing asset.

- [ ] **Step 1: Write the failing tests**

| File                | Test                                                   | Asserts                                                                                                                          |
| ------------------- | ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| `contract.test.ts`  | `the cases cover every endpoint of the API definition` | each method + path that `HttpApi.reflect` lists has at least one case                                                            |
|                     | `no case that breaks a payload or the guard succeeds`  | those cases have a status ≥ 400                                                                                                  |
|                     | `every reply matches the golden record`                |                                                                                                                                  |
| `lifecycle.test.ts` | `SIGTERM with the UI open stops in under 2 s`          | a `/ws` client connected: exit code 0, elapsed < 2000 ms, close code 1001                                                        |
|                     | `a data directory of the Nitro server opens untouched` | `legacy-v17.sqlite` copied as `<dataDir>/llama-webui.sqlite`: `GET /api/settings` gives `port: 8123` and `hiddenGpus: ['GPU-1']` |
|                     | `the build never connects to the Effect DevTools`      | a `node:http` server on a free port that counts `upgrade` requests, named by `LLAMA_WEBUI_DEVTOOLS_URL`: none within 1.5 s       |

- [ ] **Step 2: Run them to make sure they fail**

Run: `pnpm exec vitest run app/server/contract app/server/lifecycle.test.ts`

- [ ] **Step 3: Implement, then write the golden record**

Run: `UPDATE_GOLDEN=1 pnpm exec vitest run app/server/contract/contract.test.ts`, then read `golden.json` in full: a
refusal body, a 404 body and the cache headers are what Tasks 5 and 7 specified.

- [ ] **Step 4: `scripts/smoke.ts`** keeps every check E1 serves; each check that needs an unported endpoint is removed
      and noted for Task 11 with its milestone. `node scripts/smoke.ts` passes after `pnpm build`.

- [ ] **Step 5: Run everything, commit**

Run: `pnpm lint && pnpm check && pnpm test`

```bash
git add -A
git commit -m "test(server): Record the contract and the lifecycle of the Effect build"
```

---

### Task 11: Close the milestone

**Files:**

- Modify: `docs/superpowers/poc-effect/test-inventory.json`, `docs/superpowers/poc-effect/behaviours.md`, `CLAUDE.md`
- Create: `docs/superpowers/poc-effect/conventions.md`, `docs/superpowers/poc-effect/e1.json`

- [ ] **Step 1: Account for the tests.** In `test-inventory.json` (an array of entries), every entry whose
      `milestone` is `E1` gets a `status`: `ported` or `rewritten` with `to` (the new test file), or `dropped` with a
      `reason`. Re-assigned instead (their `milestone` changes, no status): the entries of
      `app/server/lib/proc.test.ts` to `E3`; the two `useEnvProxy: …` tests to `E6`; the two NVML tests of
      `app/server/build.test.ts` to `E4`; the reply half of `SIGTERM with the UI open and a reply streaming stops in under
  2 s` is noted in its `reason` as back in `E5`. Expected drops, each with its reason: the three tests of
      `api.gen.test.ts` (generator replaced by the `HttpApi` definition), the tests of `lib/db/sqlite.test.ts` whose
      behaviour belonged to the removed wrapper, the h3 helper tests of `lib/http.test.ts`, `dev reads .env.local too`
      (a Nitro behaviour).

Run: `node -e "const a=require('./docs/superpowers/poc-effect/test-inventory.json');console.log(a.filter(e=>e.milestone==='E1'&&!e.status).length)"`
Expected: `0`.

- [ ] **Step 2: Account for the behaviours.** In `behaviours.md`, section E1: every line is ticked, or struck with
      `dropped: <reason>` (the 405 with `Allow`, the 503 while starting, `.env.local` in dev, the route reload that kept
      llama-server, exit code 2 on a usage error), or moved under its milestone with a note (the monitor warning of
      `PATCH /api/settings`: E4; `GET /api/state`: E3; the smoke checks removed in Task 10). Add what is new: `--version`,
      `bootId` in `/api/health`, the second-signal handler.

- [ ] **Step 3: Write `conventions.md`** for the milestones that follow, from the code as it is: where a domain's
      schemas, API group, errors, service, handlers and tests go, with one real file as the example of each; the Effect
      diagnostics regime (what the override covers, the two allowed directives, `X.make`, the brand, the service keys);
      SQL (`CAST(… AS INTEGER)` where a number meets JSON or an untyped column); how a service registers a
      `Shutdown.before` step; how a `/ws` message and a contract case are added; how a web page comes back (routing,
      `MILESTONE_BY_PATH`, `"exclude"` of `app/tsconfig.json`); the commands (one test file, the golden record, dev). One
      page.

- [ ] **Step 4: `CLAUDE.md`.** Extend the note of Task 3 with a pointer to `conventions.md` as the rules of the new
      server. Do not rewrite the other sections (E10).

- [ ] **Step 5: Measure.**

Run: `node scripts/poc/measure.ts --out docs/superpowers/poc-effect/e1.json`, then
`pnpm exec biome format --write docs/superpowers/poc-effect/e1.json`.

- [ ] **Step 6: Run everything, commit**

Run: `pnpm lint && pnpm check && pnpm test && pnpm build && node scripts/smoke.ts`, then
`pnpm check 2>&1 | grep -c 'effect('` (expected: `0`).

```bash
git add -A
git commit -m "chore(poc): Close E1, the foundation of the Effect server"
```

- [ ] **Step 7: Hand over for validation.** Report: the parts of the Settings page that wait for E4, every dropped test
      and behaviour with its reason, every `@effect-diagnostics` directive written and why, the numbers of `e1.json` next
      to `baseline.json` (server lines, bundle sizes, startup and shutdown medians), and how to try it:
      `pnpm start --host 0.0.0.0 --port <a free port, not 7860 or 7861>` then `http://192.168.0.20:<port>/`.
