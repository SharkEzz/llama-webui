# Effect POC, E3: Supervisor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring llama-server back under the Effect server: the supervisor (launch, readiness, crash, stop, switch,
restart), the log ring, the detection of a llama-server started by hand, the `/api/server/*`, `/api/state` and
`/api/logs` endpoints, the `server-state` and `log` messages of `/ws`, and on the web the Server and Logs pages, the
status bar entry and the parts of the Profiles page that waited for the server.

**Architecture:** The shared package gets the server state and the log line as schemas, two API groups (`server`,
`logs`) with their typed errors, and two `/ws` messages. The server gets four services: `LogRing` (the lines in
memory, published in batches), `LlamaHttp` (the HTTP client every request to a llama-server goes through: direct,
`node:http`, no time limit of its own), `Supervisor` (the state, one lifecycle operation at a time, the child process
in a scope it owns) and `ExternalWatch` (a scoped loop). The process runs through `effect/process`; stopping it is the
finalizer of the `Supervisor` layer, so it runs after the HTTP server closed and before the database does.

**Tech Stack:** Effect 4.1.4 (`effect`, `effect/http`, `effect/http-api`, `effect/process`), `@effect/platform-node`
(`NodeHttpClient`), `@effect/vitest`, Node ≥ 26.13, Vitest 5, Biome.

**Spec:** `docs/superpowers/specs/2026-11-14-effect-server-design.md`. Acceptance list:
`docs/superpowers/poc-effect/behaviours.md`, section E3. Rules of the new server:
`docs/superpowers/poc-effect/conventions.md` (read it before writing code).

**Calls made by this plan** (the author's; each is recorded by Task 9):

- **The launchpad and the Home page move to E8.** `GET /api/launchpad` needs the GGUF reader (E6), the bench runs
  (E7), the estimate and the tuning hardware (E8) and the monitor (E4); the Home page needs it and the setup report
  (E8). This changes the order the spec's table gives (its E3 row names the launchpad), not the design. With them
  move: the confirmed defect of `lib/setup.ts:61` and the "Run setup again" button of Settings (the launchpad tests
  of `lib/setup.test.ts` are already listed under E8).
- **`A benchmark is running` (409 of the four lifecycle routes), the pause of the external watch during a benchmark,
  and the bench gate's use of the supervisor move to E7**, with the bench runner. No stand-in is written.
- **Requests are strict**, as E2 set: `profileId` of start and switch is an integer (was `Number(…)`: `"1"` and `true`
  selected profile 1; now a 400 `RequestInvalid`; a `profileId` that is no integer answered 404, now 400); `since` of
  `/api/logs` is a non-negative integer in decimal digits (a negative value returned the whole ring and anything else
  counted as 0; now a 400).
- **Every request to a llama-server is direct**: the probes and `/props` no longer go through the proxy of the
  environment when llama-server listens on a non-loopback address (they used Node's `fetch`; the chat and the bench
  never did). One client, one rule. This departs from one sentence of the spec ("proxy variables are honoured as
  today"), which stays true of the Hugging Face client (E6).
- **Errors are told by their tag.** The 409s and 502s keep their messages word for word and become
  `OperationInProgress`, `ServerAlreadyRunning`, `PortInUse`, `NoProfileToRestart`, `ServerNotReady`,
  `PropsUnavailable` and, on the profile deletion, `ProfileRunning`.
- **A lifecycle operation runs to its end whatever happens to the request that asked for it** (a client that goes
  away mid-start must not leave a process without its state).
- The 300 s rule of the spec (no abort after 300 s of silence) holds by construction (`node:http`, no timeout set) and
  is pinned by a test of a silence of a few seconds, not of 300 s: the Nitro server did not test the bound either.

## Global Constraints

- Branch `poc/effect`, after E2 (`docs: Drop the llama-tui import from the README`). No push, no pull request.
- **Before writing any Effect code, read `repos/effect/LLMS.md` completely**, then
  `docs/superpowers/poc-effect/conventions.md`, then the reference files of the task. `repos/effect` is the installed
  version (4.1.4): read it, not `node_modules`, and never edit it. Its modules are under
  `repos/effect/packages/effect/src/` (`http/`, `http-api/`, `process/`), the Node platform under
  `repos/effect/packages/platform/node/src/` and `platform/node-shared/src/` (`NodeChildProcessSpawner.ts`).
- **Effect diagnostics are blocking:** `pnpm check 2>&1 | grep -c 'effect('` prints `0`, warnings included. Fix what a
  rule reports with its own suggestion. No new `@effect-diagnostics` directive. The only change of
  `tsconfig.effect.json`: `packages/webui-shared/src/server.ts` and `packages/webui-shared/src/logs.ts` join the
  third override (Task 1), so their plain functions are rewritten to pass the server's rules, their tests unchanged.
  Any rule that seems wrong for a piece of code: stop and report, do not lower it.
- Idiomatic Effect only (conventions): services are `Context.Service` classes with their layers as statics, methods
  are `Effect.fn('Service.method')`, errors are `Schema.TaggedError` classes built with `X.make(…)`, time comes from
  `Clock`, configuration from `Config`, files from `FileSystem`, processes from `effect/process`. Promise code wrapped
  in `Effect.promise` does not count as ported.
- **The supervisor does not use the I/O of `llamacpp-js`** (`probeHealth`, `probeLlamaServer`, `fetchProps`,
  `findLlamaServerPid`: spec, "Outside world"): it is rewritten here on `HttpClient` and `FileSystem`. Its pure
  functions may be imported: `probeUrl` (`llamacpp-js/client`), `parseCmdline` and `portFromArgv` (`llamacpp-js/node`).
- `app/server-legacy/` is the Nitro server, a read-only reference: port its behaviour, not its structure; never import
  it. Only Task 9 deletes files in it. `site/` is not touched.
- A reply carries what the service holds: its schema has no input rule (conventions, "Replies").
- Server and shared code runs under Node as it is: relative imports end in `.ts`, erasable syntax only.
- No dependency is added. The server bundle keeps requiring nothing but Node builtins.
- **Never start anything on port 7860 or 7861.** Any run of the build or of `pnpm dev` carries a scratch data folder
  (`--data-dir <new temporary folder>`, or `LLAMA_WEBUI_DATA_DIR` for dev) and a free port: the default data folder is
  the user's real one. Tests never use port 8080 (the default port of llama-server: a real one may listen there):
  every profile of a test sets its own free port, and every test of the watch sets the `port` setting to a free one.
- Tests that run a process or a socket run on real time: `layer(L, { excludeTestServices: true })('…', (it) => …)`
  (inside a shared layer `it.live` does not exist; the `TestClock` moves no process). The durations of the services
  are options of their `layerWith`, shortened in tests. A test leaves no process behind: it asserts its fake is dead.
- Code, comments, test names, messages and commits in English. Commits end with
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- `pnpm lint`, `pnpm check` and `pnpm test` green at the end of every task. Zero Biome warning; do not disable a Biome
  rule. Format a Markdown or JSON file you wrote with `pnpm exec biome check --write <file>`.
- Shell: zsh (quote globs); start a command with `cd /home/tristan/DEV/llama-webui`.

## Facts verified on this tree

Found by reading `repos/effect` and by a throwaway test against the installed version; rely on them.

- **A child process** (`ChildProcess.make(command, args, { cwd, env, extendEnv, stdin, stdout, stderr })`, then
  `ChildProcessSpawner.spawn`, which needs a `Scope`): the handle gives `pid` (a branded number), `stdout`, `stderr`
  (streams of bytes), `exitCode`, `isRunning`, `kill({ killSignal })`. `env` alone replaces the environment;
  `extendEnv: true` lays `env` over llama-webui's own. The child is the leader of its own process group, and closing
  its scope signals the group. Under `setpriv --pdeathsig KILL -- <binary>` the pid is the binary's (`setpriv` execs).
- **A stop in two signals works as written:** against the fake with `FAKE_IGNORE_TERM=1`,
  `handle.kill({ killSignal: 'SIGTERM' }).pipe(Effect.timeoutOption('700 millis'))` gave `None` after 705 ms with the
  process still running (the wait of `kill` is interruptible), then `handle.kill({ killSignal: 'SIGKILL' })` returned
  in 4 ms.
- **`handle.exitCode` fails when a signal ended the process**: a `PlatformError` whose `reason.cause` is an `Error`
  with the message `Process interrupted due to receipt of signal: 'SIGKILL'`. It succeeds with the code otherwise (0
  after the fake handled a SIGTERM). The exit watcher treats both as an exit and reads the signal's name from that
  message (`/signal: '([A-Z0-9]+)'/`).
- **Closing the scope right after the exit loses the last output**: a program printing `a\nb\nc` gave `a`, `b` when
  the scope was closed as soon as `exitCode` answered, and `a`, `b`, `c` when the readers were joined first. The
  readers end by themselves when the process's pipes close.
- **A spawn that fails** is a `PlatformError` whose `reason.cause.message` is Node's (`spawn /no/such/binary ENOENT`).
  Node looks the command up in the `PATH` of the child's environment: a profile whose `env` sets `PATH` to an empty
  folder makes `spawn setpriv ENOENT`. A missing `cwd` fails before the spawn with the error of `FileSystem.access`.
  A missing llama-server binary is not a spawn failure: `setpriv` starts, prints its own error and exits 127.
- **The client of `node:http`**: `NodeHttpClient.layerNodeHttpOptions(agentOptions)` (`@effect/platform-node`) builds
  an `HttpClient` on `http.request` with its own `http.Agent`: no proxy (only Node's global agent reads the
  environment), no timeout of headers or body. A reply whose body is not read holds its socket until its request is
  aborted: `HttpClient.withScope(client)` ties each request to the scope of its caller, which aborts it when it
  closes. So a probe is `client.get(url).pipe(Effect.map((r) => r.status), Effect.scoped)` on such a client. The
  client follows no redirect and answers an error status as a response.
- **One at a time:** `Semaphore.make(1)`; `semaphore.withPermits(1)(effect)` waits, and
  `semaphore.withPermitsIfAvailable(1)(effect)` answers an `Option` (none when the permit is taken): read its exact
  signature in `repos/effect/packages/effect/src/Semaphore.ts`.
- **A batch of what is waiting:** `Queue.takeAll(queue)` waits for at least one item and returns them all.
- **Real time under a shared layer:** `layer(L, { excludeTestServices: true })` of `@effect/vitest`.
- **The fake llama-server** (`testdata/fake/fake-llama-server`, forwards to `fake-llama-server.ts`): `--port <n>`,
  `/health` 503 then 200 after `FAKE_LOAD_MS` (300), `/props` from `testdata/fake/props.json`, logs on stderr in
  llama.cpp's format, exits 0 on SIGTERM unless `FAKE_IGNORE_TERM=1`, `FAKE_EXIT_AFTER_MS` with `FAKE_EXIT_CODE`,
  `FAKE_FAIL_ARG`. Its variables reach it through the profile's `env`. It logs its working directory
  (`srv  main: cwd <dir>`). It listens on `127.0.0.1` whatever `--host` says: Task 5 makes it read `--host` (default
  `127.0.0.1`; it is test data, and `127.0.0.2` is loopback on Linux).
- **The web's shell lost at E1** the status bar entry (`git show 8f6fe3581 -- app/src/app/StatusBar.tsx`) and the
  `startServerSync()` and `startLogsSync()` calls of `app/src/main.tsx`; the Profiles page lost its server parts at E2
  (`git show 7b30a72a5 -- app/src/features/profiles/`).

## Reference files

- Legacy behaviour (read, never import): `app/server-legacy/lib/supervisor/{supervisor,args,control,external}.ts` and
  their tests, `lib/logs/{buffer,lines}.ts`, `lib/runtime.ts` (`serverView`, `activeProfileId`), `lib/boot.ts` (the
  order of the stop, the watch), `lib/context.ts` (the exit handler), `lib/profiles/remove.ts`,
  `routes/api/server/*.ts`, `routes/api/{state,logs}.get.ts`, `lib/llamaFetch.ts` and its test,
  `packages/llamacpp-js/src/client.ts` (the probes, `fetchProps`) and `node.ts` (`findLlamaServerPid`).
- The model of each part: `app/server/flags/Flags.ts` (a program run through `effect/process`), `app/server/ws/WsHub.ts`
  (a service with scoped fibers and a shutdown step), `app/server/profiles/http.ts` and its test (handlers, raw HTTP
  tests), `app/server/contract/cases.ts`, `app/src/lib/profiles.ts` (a web store on `call`), `app/server/App.ts`
  (the tiers of services).

## Review Focus

What a person will meet that the acceptance list does not spell out; each line is pinned by a test in the task named.

1. The browser tab is closed, or the request times out, while a start or a stop is in progress: the operation still
   ends, the state matches the process, the next operation is not refused for ever (Task 5).
2. Two things change the state at once (the health poll says ready while a stop begins; the process exits while the
   watch probes): clients receive the states in the order they happened, and a late answer never undoes a newer state
   (`ready` only from `starting` of that process, `external` only from `idle` or `crashed`) (Task 5).
3. llama-server dies on its own: at once, before it listens, killed from outside, or with its last line unterminated:
   the state is `crashed` with the code or the signal, and every line it wrote is in the ring (Task 5).
4. A profile whose binary, folder or `PATH` is wrong: a 202 with the state `crashed` and a message a person can act
   on, never a 500, and the profile is still the one "restart" takes (Tasks 5 and 7).
5. The port is already used: by a llama-server started by hand (state `external`, the 409 names its pid), by another
   program (409 naming the port), by an `external` server that has since gone (a normal launch) (Task 5).

---

### Task 1: Schemas, the two groups and their errors

**Files:**

- Modify: `packages/webui-shared/src/server.ts`, `logs.ts`, `ws.ts`, `api/ProfilesApi.ts`,
  `api/params.ts`, `index.ts`, `tsconfig.effect.json`
- Create: `packages/webui-shared/src/api/ServerApi.ts`, `api/LogsApi.ts`, `packages/webui-shared/src/server.test.ts`

**Interfaces (produced):**

- `server.ts`, on Schema, the union kept on its `kind` key (the pages read `state.kind`):
  `ServerState` = union of the six structs of today's type (`idle`; `starting` and `ready` with `profile: String`,
  `profileId`, `pid`, `host`, `port`, `since`; `stopping` without `since`; `crashed` with `profile`, `profileId`,
  `exitCode: NullOr(Int)`, `signal: NullOr(String)`, `at`, `message: optionalKey(String)`; `external` with
  `pid: NullOr(Int)`, `port`), every number a `Schema.Int`; `ServerView` = `{ state, command: NullOr(String),
  profileId: NullOr(Int) }`; the types are their `.Type`. Kept: `stateHost(state)`. Added:
  `activeProfileId(state: ServerState): number | null` (the profile while `starting`, `ready` or `stopping`, else
  null) and `serverView({ state, last }: { state: ServerState; last: { display: string; profileId: number } | null }):
  ServerView` (`command` is `last.display`; `profileId` is the state's when it has one, else `last`'s, else null).
- `logs.ts`: `LogLevel` and `LogKind` as `Schema.Literals`, `LogLine` as a struct (`seq: Int`, `text`, `level`,
  `kind`), types from `.Type`; everything else keeps its name and behaviour.
- `ws.ts`: `WsServerState` (`type: 'server-state'`, `payload: ServerView`) and `WsLog` (`type: 'log'`,
  `payload: Schema.Array(LogLine)`), both in `WsMessage`.
- `api/params.ts`: `SeqParam: Schema.Codec<number, string>`, a non-negative integer in decimal digits (the pattern of
  `IdParam`, minimum 0).
- `api/ServerApi.ts`, group `server`. Errors, each `{ message: Schema.String }` unless said:

  | Error                  | Status | Message                                                                                                                                                                         |
  | ---------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | `OperationInProgress`  | 409    | `operation in progress, try again`                                                                                                                                              |
  | `ServerAlreadyRunning` | 409    | `a server is already running`                                                                                                                                                   |
  | `PortInUse`            | 409    | `port in use by an external server (PID <pid or unknown>)` or `port <port> is in use by another service`; also `port: Int`, `by: 'llama-server' \| 'other'`, `pid: NullOr(Int)` |
  | `NoProfileToRestart`   | 409    | `No profile to restart`                                                                                                                                                         |
  | `ServerNotReady`       | 409    | `Server not ready`                                                                                                                                                              |
  | `PropsUnavailable`     | 502    | `llama-server /props: HTTP <status>`, `llama-server /props: the reply is not JSON` or `llama-server is not responding on /props`                                                |

  Endpoints (`Accepted` = `ServerView` with status 202; `Launch` = `Schema.Struct({ profileId: Schema.Int })`):

  | Name       | Method and path            | Payload  | Success                                               | Errors                                                                        |
  | ---------- | -------------------------- | -------- | ----------------------------------------------------- | ----------------------------------------------------------------------------- |
  | `state`    | `GET /api/server/state`    |          | `ServerView`                                          |                                                                               |
  | `start`    | `POST /api/server/start`   | `Launch` | `Accepted`                                            | `ProfileNotFound`, `OperationInProgress`, `ServerAlreadyRunning`, `PortInUse` |
  | `switch`   | `POST /api/server/switch`  | `Launch` | `Accepted`                                            | `ProfileNotFound`, `OperationInProgress`, `PortInUse`                         |
  | `restart`  | `POST /api/server/restart` |          | `Accepted`                                            | `NoProfileToRestart`, `ProfileNotFound`, `OperationInProgress`, `PortInUse`   |
  | `stop`     | `POST /api/server/stop`    |          | `ServerView`                                          |                                                                               |
  | `props`    | `GET /api/server/props`    |          | `Schema.Unknown` (llama-server's own JSON)            | `ServerNotReady`, `PropsUnavailable`                                          |
  | `snapshot` | `GET /api/state`           |          | `{ server: ServerView, logSeq: Int, bootId: String }` |                                                                               |

- `api/LogsApi.ts`, group `logs`: `list`, `GET /api/logs`, query `{ since: Schema.optionalKey(SeqParam) }`, success
  `{ lines: Schema.Array(LogLine), seq: Int, bootId: String }`.
- `api/ProfilesApi.ts`: `ProfileRunning` (409, `This profile belongs to the running server: stop it first`), added to
  the errors of `remove`.
- `index.ts` exports the two groups and every error by name (check the barrel for a clash first: conventions, "Where
  a domain goes"). `Api.ts` is changed by Tasks 2 and 7 (Step 4).

- [ ] **Step 1: Write the failing tests** in `server.test.ts`:
  - `activeProfileId is the profile while starting, ready or stopping, null otherwise`: one state of each kind.
  - `serverView: the profile of the state, else of the last command, else null; the command survives a stop`:
    `idle` with `last` `{ display: 'x', profileId: 4 }` → `{ command: 'x', profileId: 4 }`; `crashed` of profile 2 with
    that `last` → `profileId: 2`; `external` without `last` → `command: null`, `profileId: null`.
  - `a crashed state without a message encodes without the key`: `Schema.encodeSync(ServerState)` of a `crashed`
    state built without `message` has no `message` key.
  - `SeqParam reads 0 and 12, refuses -1, 1.5, "abc" and ""`.
- [ ] **Step 2: Run them, see them fail.** `pnpm exec vitest run packages/webui-shared/src/server.test.ts`
- [ ] **Step 3: Write the schemas, the groups and the errors**; move `server.ts` and `logs.ts` into the third override
      and rewrite what the diagnostics then report in them.
- [ ] **Step 4: Green.** The tests above, `packages/webui-shared/src/logs.test.ts` unchanged and green,
      `pnpm check` with 0 `effect(` line. A group added to `Api` must have its handlers for the server to type-check:
      this task defines and exports the two groups, and each joins `Api` in the task that serves it (`LogsApi` in
      Task 2, `ServerApi` in Task 7), still above the annotation and the middleware.
- [ ] **Step 5: Commit** `feat(shared): Describe the server state, the logs and their API with Schema`.

### Task 2: The log ring

**Files:**

- Create: `app/server/logs/lines.ts`, `lines.test.ts`, `LogRing.ts`, `LogRing.test.ts`, `http.ts`, `http.test.ts`
- Modify: `packages/webui-shared/src/api/Api.ts`, `app/server/App.ts`, `app/server/testing/services.ts`,
  `app/server/http/HttpLive.ts`, `app/server/contract/cases.ts`, `golden.json`

**Interfaces (produced):**

- `lines.ts`: `linesOf: <E>(bytes: Stream.Stream<Uint8Array, E>) => Stream.Stream<string, E>` (UTF-8 decoded across
  chunks, split on `\n`, each line without its ANSI escape sequences, its trailing `\r` and its trailing whitespace,
  empty lines dropped, the last unterminated line emitted when the stream ends) and `isIdleNoise(line): boolean`
  (ends with `update_slots: all slots are idle`).
- `LogRing.ts`, key `@llama-webui/app/server/logs/LogRing`:
  `push: (text: string) => Effect.Effect<void>` (numbers the line from 0, classifies it with `classifyLine`, keeps the
  last `capacity` lines; numbering and queueing for publication are one step, no other push comes between);
  `since: (seq: number) => Effect.Effect<ReadonlyArray<LogLine>>` (the lines still held whose number is at least
  `seq`); `seq: Effect.Effect<number>` (the number of the next line). `static layerWith({ capacity })`,
  `static layer` (10 000). A fiber of the layer publishes what was pushed since its last turn as one `log` message
  (`WsHub.publish`), in order.
- `http.ts`: `LogsHandlers` (`list`: `since ?? 0`, with `seq` and `AppInfo.bootId`).
- `LogRing.layer` goes in a tier of `Services` (`App.ts`) built after the hub; `ServicesTest` the same.

- [ ] **Step 1: Write the failing tests.**
  - `lines.test.ts`: `the idle loop line of -lv 4 is noise, the request lines are not (#16)` (the legacy cases);
    `lines are rebuilt across chunks, cleaned, and the last one is flushed`: chunks `"a\x1b[31mb\x1b[0m\r\n  \nc d  \n"`,
    `"e"`, `"f"` give `['ab', 'c d', 'ef']`; a multi-byte character cut between two chunks comes out whole.
  - `LogRing.test.ts` (a hub that records what is published, provided as `Layer.succeed(WsHub, …)`):
    `lines are numbered from 0 and classified` (an `E` prefix of llama.cpp is `error`, `srv ` is kind `srv`, a plain
    `failed` word is `error`); `since keeps the lines whose number is at least the one asked, and the ring forgets the
    oldest` (capacity 3, five pushes: `since(0)` is lines 2 to 4, `since(4)` one line, `since(9)` none, `seq` 5);
    `what was pushed is published as log messages, every line once, in order` (ten pushes, then the recorded payloads
    concatenated are lines 0 to 9).
  - `http.test.ts`: `GET /api/logs answers the lines from since, the next number and the boot id` (three pushes;
    `?since=1` gives two lines, `seq` 3, the `bootId` of `/api/health`); over raw HTTP,
    `since=-1 and since=abc are a 400 RequestInvalid`.
- [ ] **Step 2: Run them, see them fail.**
- [ ] **Step 3: Implement**, add `LogsApi` to `Api`, `LogsHandlers` to `ApiRoutes`, the layer to `Services` and
      `ServicesTest`.
- [ ] **Step 4: Contract.** Cases `GET /api/logs`, `GET /api/logs?since=0` and the violation `GET /api/logs?since=abc`;
      regenerate the golden and read its diff (the boot id masked as the health case masks its own).
- [ ] **Step 5: Green and commit** `feat(server): Keep llama-server's log in a ring and serve it`.

### Task 3: Reaching a llama-server

**Files:**

- Create: `app/server/llama/LlamaHttp.ts`, `LlamaHttp.test.ts`, `probes.ts`, `probes.test.ts`, `procScan.ts`,
  `procScan.test.ts`, `app/server/testing/llama.ts`
- Modify: `app/server/App.ts`, `app/server/testing/services.ts`

**Interfaces (produced):**

- `LlamaHttp.ts`, key `@llama-webui/app/server/llama/LlamaHttp`: a service whose value is an `HttpClient.HttpClient`
  (`Context.Service<LlamaHttp, HttpClient.HttpClient>`), **under its own tag**: `HttpClient.HttpClient` itself is the
  test server's client in the HTTP tests, and Hugging Face gets another client at E6. `static layer`: the client of
  `NodeHttpClient.layerNodeHttpOptions({ keepAlive: false })`, wrapped with `HttpClient.withScope`.
- `probes.ts` (each needs `LlamaHttp`; `host` absent, empty or a wildcard means loopback, through `probeUrl`):
  - `health: (target: { host?: string | null; port: number }) => Effect.Effect<Option.Option<number>, never, LlamaHttp>`:
    the status `/health` answers, none when nothing answers within 800 ms.
  - `isLlamaServer: (target) => Effect.Effect<boolean, never, LlamaHttp>`: `/health` answers JSON that is an object
    with a string `status`, or with `error.type === 'unavailable_error'`, within 800 ms.
  - `props: (baseUrl: string) => Effect.Effect<unknown, PropsUnavailable, LlamaHttp>`: the JSON of `/props` within
    2 s; an error status, a body that is not JSON, and no answer give the three messages of Task 1.
- `procScan.ts`:
  `findLlamaServerPid: (options: { port: number; root?: string }) => Effect.Effect<Option.Option<number>, never, FileSystem.FileSystem | Path.Path>`
  (`root` defaults to `/proc`: the first numeric entry whose `cmdline`, read with `parseCmdline`, has an `argv[0]`
  named `llama-server` and whose `portFromArgv` is `port`; an unreadable entry is skipped, an unreadable root is none)
  and `isAlive: (pid: number) => Effect.Effect<boolean>` (signal 0).
- `testing/llama.ts` (plain Node is allowed there): what the tests of Tasks 3 to 7 share. At least: `FAKE` (the path
  of `testdata/fake/fake-llama-server`), `freePort()`, a scoped `httpStub(handler)` answering on a free loopback port
  (for "another service", for the `/props` variants and for the probes), a scoped `fakeOutside({ port, env })` that
  runs the fake as a process llama-webui did not start, and `pidAlive(pid)`.

- [ ] **Step 1: Write the failing tests.**
  - `LlamaHttp.test.ts` (rewrites the nine `llamaFetch:` tests that concern a client; real time):
    `sends the method, the headers and the body, and answers the status, the headers and the body`;
    `an error status is a response, not a failure`;
    `the body is streamed as it arrives, and leaving it closes the connection` (the stub sees the socket close after
    the first chunk was read and the scope closed);
    `nothing listening fails with a transport error`;
    `a timeout before the answer ends the request and closes the connection`;
    `a connection cut during the body fails the stream`;
    `stays direct when the environment sets a proxy` (`HTTP_PROXY`, `HTTPS_PROXY` and `ALL_PROXY` set to a stub that
    counts its requests: it counts none; restore the environment);
    `a redirect is the response, not followed`;
    `a silence of 3 s before the headers and between two chunks does not end the request`.
  - `probes.test.ts`: `health is the status, none when nothing listens or nothing answers within 800 ms` (200, 503, a
    closed port, a stub that never answers: none after about 800 ms, and the stub sees its socket closed);
    `health reaches loopback for a wildcard host` (`0.0.0.0`, `''`, absent);
    `isLlamaServer: {"status":"ok"} and an unavailable_error are one, a web page and a JSON array are not (#28)`;
    `props: the JSON as it is; an error status, a body that is not JSON and no answer are PropsUnavailable with their
    message (#37)`.
  - `procScan.test.ts` (a folder made like `/proc`, `<pid>/cmdline` with NUL separators):
    `the pid of the llama-server on the port; 8080 when it names no port; another program on the port is not one`;
    `an entry that cannot be read is skipped, a root that does not exist is none`;
    `isAlive: this process is, a pid that never ran is not`.
- [ ] **Step 2: Run them, see them fail.**
- [ ] **Step 3: Implement.** `LlamaHttp.layer` joins the tier of `LogRing` in `Services` and `ServicesTest`.
- [ ] **Step 4: Green and commit** `feat(server): Reach a llama-server over a direct HTTP client`.

### Task 4: The launch command

**Files:**

- Create: `app/server/supervisor/command.ts`, `command.test.ts`,
  `packages/webui-shared/src/shell.test.ts` (if the shell tests are not there yet)

**Interfaces (produced):**

- `BuiltCommand` (a plain readonly interface): `argv: ReadonlyArray<string>` (`setpriv --pdeathsig KILL --` then the
  server's command), `display: string` (the server's command, shell-quoted, without the prefix), `cwd: string`,
  `env: Readonly<Record<string, string>>` (the settings' variables then the profile's: what is laid over
  llama-webui's own environment by `extendEnv`), `p2p: boolean` (`GGML_CUDA_P2P` is set, in `env` or in llama-webui's
  environment), `host`, `port`, `profileName`, `profileId`.
- `profilePaths: (options: { profile: Pick<Profile, 'model' | 'mmproj' | 'cwd'>; home: string; cwd: string }) =>
  { cwd: string; model: string; mmproj: string | null }` (pure: `~` expanded everywhere, the model and the projector
  resolved from the profile's folder, which defaults to `cwd`). E4 reads it for the monitor.
- `commandOf: (options: { profile: Profile; settings: Pick<Settings, 'binary' | 'host' | 'port' | 'env'>; home: string;
  cwd: string; p2pInEnvironment: boolean }) => BuiltCommand` (pure; the rules of `app/server-legacy/lib/supervisor/args.ts`,
  `-lv 4` included).
- `buildCommand: (options: { profile: Profile; settings: Settings }) => Effect.Effect<BuiltCommand, never, Path.Path>`:
  `commandOf` with the home folder (`homeDir` of `config/Home.ts`), llama-webui's working directory, and whether
  `GGML_CUDA_P2P` exists in its environment (read through `Config`; if an empty value reads as absent there, keep it
  and record the deviation: only a set-but-empty variable of llama-webui's own environment no longer adds the line).
- `launchLines: (cmd: Pick<BuiltCommand, 'display' | 'p2p'>) => ReadonlyArray<string>` (`LAUNCH_LOG_PREFIX` and the
  display, then `P2P_LOG_LINE` when `p2p`).

- [ ] **Step 1: Port the tests** of `app/server-legacy/lib/supervisor/args.test.ts` onto `commandOf`, `profilePaths`
      and `launchLines`, same names and same values: the eleven that concern the command go to `command.test.ts`
      (`env merges process env with profile env` becomes `the settings variables then the profile ones are laid over
      the environment`, asserting `env` holds only those and the profile wins; the process's own environment is
      checked in Task 5), the four on `shellQuote` and `shellSplit` to `shell.test.ts` of the shared package.
- [ ] **Step 2: Run them, see them fail. Step 3: Implement. Step 4: Green.**
- [ ] **Step 5: Commit** `feat(server): Build the launch command of a profile`.

### Task 5: The supervisor

**Files:**

- Create: `app/server/supervisor/Supervisor.ts`, `Supervisor.test.ts`, `app/server/testing/fixtures/exitWithServer.ts`
- Modify: `app/server/App.ts`, `app/server/testing/services.ts`, `app/server/lifecycle.test.ts`,
  `testdata/fake/fake-llama-server.ts` (reads `--host`)

**Interfaces (produced)**, key `@llama-webui/app/server/supervisor/Supervisor`:

```ts
{
  readonly state: Effect.Effect<ServerState>;
  /** The last command launched (kept after a stop), none before any launch. */
  readonly lastCommand: Effect.Effect<Option.Option<BuiltCommand>>;
  readonly view: Effect.Effect<ServerView>;
  readonly start: (cmd: BuiltCommand) => Effect.Effect<void, OperationInProgress | ServerAlreadyRunning | PortInUse>;
  /** Stops the managed server, then launches `cmd`, as one operation. */
  readonly switchTo: (cmd: BuiltCommand) => Effect.Effect<void, OperationInProgress | PortInUse>;
  /** Waits for the operation in progress, then stops the managed server; never touches an external one. */
  readonly stop: Effect.Effect<void>;
  /** A llama-server on `port` that llama-webui did not start: the state becomes `external`. */
  readonly detectExternal: (port: number) => Effect.Effect<boolean>;
  /** Leaves the `external` state once that server is gone. */
  readonly recheckExternal: Effect.Effect<void>;
}
```

`static layerWith(options: { killTimeout: Duration.Input; healthPoll: Duration.Input; procRoot?: string })`,
`static layer` (5 s, 500 ms, `/proc`). Needs `LogRing`, `WsHub`, `LlamaHttp`, the spawner, `FileSystem`, `Path`. In
`App.ts` it is a tier of its own above the hub, the ring, the client and the repositories: its finalizer still writes
to the ring and publishes.

**Rules** (the behaviours list, "Background work", is the detail; `supervisor.ts` of the legacy the reference):

- **One change, one message, in order.** Every change of state goes through one function that, under its own lock,
  applies a function of the current state (which may refuse: the state is no longer the one the caller saw) and
  publishes the new `ServerView` as `server-state`. Nothing else sets the state or publishes it. Conditional changes:
  `ready` only from `starting` of this process; `external` only from `idle` or `crashed` with no managed process;
  `idle` after a recheck only from that same `external` state.
- **One operation at a time.** `start` and `switchTo` fail with `OperationInProgress` when another operation holds
  the permit; `stop` waits for it. An operation is uninterruptible as a whole; its bounded waits (the 5 s of a stop)
  are made interruptible inside.
- **Start**, in this order: in the `external` state, a server that still answers `health` on its port is `PortInUse`
  (`by: 'llama-server'`, the state's pid), one that does not makes the state `idle`; a managed process is
  `ServerAlreadyRunning`; an answer of `health` on the command's host and port is `PortInUse`, `by: 'other'` when
  `isLlamaServer` says no, else the state becomes `external` (pid from `findLlamaServerPid`) and the error names that
  pid; the command becomes the last command; a `cwd` that does not exist ends the launch (below) with
  `directory not found: <cwd>`; the process is spawned (`argv`, `cwd`, `env` with `extendEnv: true`, stdin ignored), a
  spawn failure ends the launch with the message of the error's cause (`spawn setpriv ENOENT`); the launch lines go
  to the ring; the state becomes `starting`.
  A launch that ends early writes `[llama-webui] launch failed: <message>` to the ring and sets `crashed` with
  `exitCode: null`, `signal: null`, `at`, `message`; `start` still succeeds.
- **While it runs**, in the process's own scope: one reader per stream (`linesOf`, without the idle noise, into the
  ring); a poll of `health` on the command's host every `healthPoll` until a 200 (`ready`, a new `since`), with no
  deadline.
- **When it exits**, once per process, whoever sees it first: the readers are joined (at most 1 s: a grandchild may
  hold the pipes), `[llama-webui] llama-server exited (code <code or ->[, <signal>])` goes to the ring, the state
  becomes `idle` if it was `stopping`, else `crashed` with the code, the signal and `at`; the process's scope closes.
- **Stop:** no process: `crashed` becomes `idle`, anything else stays. Else `stopping` (from `starting` or `ready`),
  SIGTERM, a wait of `killTimeout`, then `[llama-webui] not stopped after <ms> ms, SIGKILL` and SIGKILL; it returns
  once the exit above has been handled.
- **The end of the layer** stops the managed server the same way, after logging `stopping llama-server…`
  (`Effect.logInfo`) when one is alive.
- **Last resort:** a `process.on('exit')` handler, registered when the layer is built and removed when it is undone,
  sends SIGKILL to the live pid synchronously (a plain variable holds it).

- [ ] **Step 1: Write the failing tests** in `Supervisor.test.ts` (real time, the fake through `buildCommand` of a
      profile whose `env` carries the `FAKE_*` variables, `killTimeout` and `healthPoll` shortened, a hub that records):
  1. `start: starting with the pid, then ready once /health answers 200`: `state.pid` is alive, `since` moved.
  2. `the ring holds the launch line, then what llama-server wrote, without the idle noise`.
  3. `cwd and the environment reach llama-server: the settings variables, the profile ones over them, llama-webui's own under both`
     (the fake logs its cwd; add a line for a variable if it logs none).
  4. `stop: stopping, then idle; the ring ends with "llama-server exited (code 0)"; the process is gone`.
  5. `a server that ignores SIGTERM is killed after the timeout: the ring says so, then "(code -, SIGKILL)"`
     (`FAKE_IGNORE_TERM=1`, `killTimeout` 300 ms).
  6. `stop returns as soon as llama-server exited, long before the kill timeout` (`killTimeout` 30 s; under 2 s).
  7. `a stop while starting ends idle and never turns ready` (`FAKE_LOAD_MS` 2000; no `ready` among the published
     states 500 ms later).
  8. `a crash: crashed with the exit code` (`FAKE_EXIT_AFTER_MS`, `FAKE_EXIT_CODE=3`) `; killed from outside: crashed
     with the signal and no code`; each with its `exited` ring line.
  9. `a server that dies at once leaves every line it wrote in the ring, the last one included` (`FAKE_FAIL_ARG`, or
     a missing binary: the line of `setpriv`, code 127).
  10. `a launch in a folder that does not exist is crashed with "directory not found: <cwd>", the ring line, and the
      command is remembered`.
  11. `a launch that cannot spawn is crashed with the cause` (profile `env` with `PATH` set to an empty folder:
      the message starts with `spawn setpriv`).
  12. `a start while another operation runs is OperationInProgress; once it ended, ServerAlreadyRunning`.
  13. `a stop waits for the operation in progress` (a start and a stop forked together end `idle`).
  14. `a start whose caller is interrupted still ends: the state is starting or ready with a live pid, and the next
      stop works`.
  15. `a port where another service answers is PortInUse naming the port; where a llama-server answers, the state is
      external and PortInUse names its pid` (`httpStub`; `fakeOutside` with a `procRoot` folder naming its pid).
  16. `in the external state, a start is refused while that server answers and goes through once it is gone`.
  17. `stop turns crashed into idle and leaves external as it is`.
  18. `switchTo stops the running server, then launches the other profile` (the first pid is dead, the state names
      the second profile).
  19. `every change is published once as server-state, in the order it happened` (a start, ready, a stop: `starting`,
      `ready`, `stopping`, `idle`; each payload is the `view` of that moment).
  20. `the health poll reaches the address llama-server listens on (#28)` (`--host 127.0.0.2`: `ready`).
  21. `detectExternal: a llama-server on the port is external with its pid; not while a server is managed; another
      service is not one`.
  22. `recheckExternal: a silent server whose pid is alive stays external; gone, the state is idle`.
  23. `the end of the layer stops llama-server` (the scope closed: the pid is dead).
- [ ] **Step 2: Run them, see them fail. Step 3: Implement**, add the tier to `App.ts` and `ServicesTest`.
- [ ] **Step 4: The exit without finalizers.** `testing/fixtures/exitWithServer.ts` builds the supervisor, starts the
      fake, prints its pid, then calls `process.exit(1)`; a test of `lifecycle.test.ts`,
      `an exit without its finalizers leaves no llama-server`, runs it and waits for the pid to die. (The kernel's
      `pdeathsig` kills it too: the test proves the outcome, not which of the two did it; say so in a comment.)
- [ ] **Step 5: Green and commit** `feat(server): Supervise llama-server`.

### Task 6: The watch of a server started by hand

**Files:**

- Create: `app/server/supervisor/ExternalWatch.ts`, `ExternalWatch.test.ts`
- Modify: `app/server/App.ts`

**Interfaces (produced):** `ExternalWatch.layerWith({ interval })` and `ExternalWatch.layer` (2 s), a layer that
provides nothing: a scoped fiber that checks once as soon as it is built (without holding the start of the app), then
every `interval`, never two checks at once. A check: in `external`, `recheckExternal`; in `idle` or `crashed`,
`detectExternal` on the `port` setting then on the last command's port, each once, stopping at the first detection;
otherwise nothing. Built last among the services (`App.ts`): undone first, no check runs while the rest stops. Not in
`ServicesTest`: a test that wants it provides it.

- [ ] **Step 1: Write the failing tests** (real time, `interval` 100 ms):
  - `a llama-server on the settings port is detected at the start, then gone once it stops` (`fakeOutside` on the
    `port` setting: `external` within a second; stopped: `idle`).
  - `after a crash, the settings port and the last profile port are watched (#39, #28)`: a profile on port A crashes,
    a `fakeOutside` on A is detected though the `port` setting is B.
  - `nothing is probed while a server is starting, ready or stopping` (a stub on the settings port counts no request
    while the fake runs on another port).
- [ ] **Step 2: Fail. Step 3: Implement. Step 4: Green and commit** `feat(server): Watch for a llama-server started by hand`.

### Task 7: The server over HTTP

**Files:**

- Create: `app/server/supervisor/http.ts`, `http.test.ts`
- Modify: `packages/webui-shared/src/api/Api.ts`, `app/server/profiles/removeProfile.ts`,
  `app/server/profiles/http.ts` and its test, `app/server/http/HttpLive.ts`, `app/server/contract/cases.ts`, `golden.json`, `app/server/lifecycle.test.ts`,
  `app/server/dev.test.ts`

**Interfaces (produced):** `ServerHandlers`:

- `state`, `snapshot` (`view`, `LogRing.seq`, `AppInfo.bootId`).
- `start`: the profile (`ProfileNotFound`), its command built from the profile and the settings as they are now,
  `Supervisor.start`, then the `defaultProfileId` setting set to it when it differs (also after a launch that ended
  `crashed`), the view.
- `switch`: the same with `switchTo`.
- `restart`: the `profileId` of the view (`NoProfileToRestart` when null), its command rebuilt from the database (a
  deleted profile is `ProfileNotFound`), `switchTo`; `defaultProfileId` untouched.
- `stop`: `Supervisor.stop`, the view.
- `props`: in `ready` or `external` (else `ServerNotReady`), `props(probeUrl(stateHost(state), state.port))`.
- `removeProfile`: `ProfileRunning` when `activeProfileId` of the state is the id, before anything else.

- [ ] **Step 1: Write the failing tests** in `http.test.ts` (real time, the fake, raw HTTP for what the edge refuses):
  - `start answers 202 with the view, sets the default profile, and state then says ready`.
  - `start of a profile that does not exist is a 404 ProfileNotFound; a profileId that is "1", true or missing is a 400 RequestInvalid`.
  - `a start that cannot launch is still a 202: crashed with its message, the profile remembered, restart takes it`.
  - `start while a server runs is a 409 ServerAlreadyRunning; on a taken port a 409 PortInUse with by and pid`.
  - `switch stops the running profile and starts the other, which becomes the default`.
  - `restart without any launch is a 409 NoProfileToRestart; after a stop it relaunches the last profile with its
    edits; of a deleted profile it is a 404; it leaves the default profile alone`.
  - `stop answers 200 once llama-server exited, and keeps the command and the profile of the view`.
  - `props: llama-server's JSON as it is when ready; a 409 ServerNotReady when idle or starting; a 502 for an error
    status, for a body that is not JSON (#37) and for no answer` (an `external` state on an `httpStub` for the 502s).
  - `GET /api/state: the view, the next log number and the boot id`.
  - in `profiles/http.test.ts`: `deleting the profile of the running server is a 409 ProfileRunning while starting,
    ready or stopping; after the stop it is deleted`.
- [ ] **Step 2: Fail. Step 3: Implement**, `ServerApi` into `Api`, `ServerHandlers` into `ApiRoutes`.
- [ ] **Step 4: Contract** (no llama-server runs there: the values of a run would change the golden). Cases: `state`
      (idle), `snapshot`, `stop` (200, idle), the refusals `start` and `switch` of an unknown profile (404), `restart`
      (409 `NoProfileToRestart`), `props` (409 `ServerNotReady`), the violations of `start` (`{}`,
      `{"profileId":"1"}`). Regenerate, read the diff.
- [ ] **Step 5: The stops of the app** (the `From E1` line of the behaviours list). In `lifecycle.test.ts`:
      `SIGTERM with llama-server running stops it and exits 0 in under 2 s` (the build, a profile of the fake started
      through the API, a `/ws` client open: the client sees 1001, the pid is dead, the data folder's database opens
      again). In `dev.test.ts`, the fake started through the API before each of: `saving a server file restarts the
      server` (the old llama-server is dead, the state after the restart is `idle`), `one SIGINT stops vite dev and
      the server`, `two quick SIGINTs still stop the server` (no llama-server left).
- [ ] **Step 6: Green and commit** `feat(server): Serve the state and the commands of llama-server`.

### Task 8: The Server and Logs pages

**Files:**

- Modify: `app/src/lib/server.ts`, `logs.ts`, `props.ts`, `app/src/main.tsx`, `app/src/app/router.tsx`, `routes.ts`,
  `StatusBar.tsx`, `app/src/features/server/*`, `app/src/features/logs/*`, `app/src/features/profiles/*`,
  `app/tsconfig.json`

What comes back, each call through `call((api) => api.<group>.<endpoint>(…))` and each error told by its tag:

- `lib/server.ts` (`useServer`, `startServerSync`, `startProfile`, `switchProfile`, `restartServer`, `stopServer`,
  `isRunning`): the state reread on every (re)connection (`api.server.snapshot`), `server-state` messages, an action's
  error shown as a toast of its `message`. `lib/logs.ts`: `api.logs.list({ query: { since } })`. `lib/props.ts`:
  `api.server.props()`; `src/lib/props.test.ts` leaves the `exclude` of `app/tsconfig.json`.
- `main.tsx` starts both syncs again. `/server` and `/logs` enter `PORTED` and leave `MILESTONE_BY_PATH`, where `/`
  becomes `E8`.
- The status bar entry (the lines E1 removed).
- The Profiles page (the `From E2` line of section E3): the running marker in the list, the preselection of the
  running profile on opening, "Start this profile", the dialog offering a restart after a save that changed the
  command of the running profile (`commandChanged` of `draft.ts`), the delete button disabled for the running
  profile, and a `ProfileRunning` answer shown as its message.
- Pages not ported yet that import `@/lib/server` or `@/lib/logs` are not touched (they are not type-checked).

- [ ] **Step 1: Port the stores and the pages**, restoring from git what E1 and E2 removed rather than rewriting it.
- [ ] **Step 2: Tests.** The web's tests green; `props.test.ts` type-checked again.
- [ ] **Step 3: Try it** on the build with a scratch data folder, a free port and the fake as the `binary` setting
      (`node app/.output/llama-webui.mjs --host 127.0.0.1 --port <free> --data-dir <tmp>`): over HTTP, create a
      profile of the fake on a free port, start it, read `/api/state` until `ready`, `/api/logs`, `/api/server/props`,
      restart, stop; then stop the app and check no fake is left (`pgrep -f fake-llama-server`). Put the commands and
      their answers in the report.
- [ ] **Step 4: Green and commit** `feat(web): Bring the Server and Logs pages back`.

### Task 9: Close the milestone

**Files:**

- Modify: `docs/superpowers/poc-effect/behaviours.md`, `test-inventory.json`, `defects.md`, `conventions.md`
- Delete: the legacy files listed below
- Create: `docs/superpowers/poc-effect/e3.json`

- [ ] **Step 1: Behaviours.** Section E3: every line ticked with what proves it (a test by its file and name, or a
      contract case), in the format of sections E1 and E2; a line that changed says how it behaves now (the calls at
      the top of this plan); every "Not covered by a test" line ticked with the test this plan added, or moved.
      Moved, as a `From E3:` line in the section of its milestone:
  - to **E8**: `GET /api/launchpad` and its background line, the Home page (launchpad and setup checklist), "Run setup
    again" of Settings, the "not covered" line of the launchpad's fit badge;
  - to **E7**: the 409 `A benchmark is running` of start, switch, restart and stop with its "not covered" line, the
    pause of the watch while the bench gate is held or the runner busy, the bench gate's use of `state`,
    `lastCommand`, `stop` and `start`;
  - to **E5**: the chat stream through `LlamaHttp` (stopping the request when left early);
  - to **E6**: `downloadFetch` (redirect not followed, HTTP/1.1, `node:https`, the proxy of the environment);
  - to **E4**: the monitor's reading of the state and `profilePaths` as its model path resolver.
    The lines on `llamaFetch` say `LlamaHttp`; the line on the dev reload says what `node --watch` does now.
- [ ] **Step 2: Tests.** In `test-inventory.json`, the fifty `E3` entries get a status (edited by a throwaway script,
      never regenerated; `0` left without one):

  | Entries                                                                                                             | Status                                                                              |
  | ------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
  | `llamaFetch:` 1, 2, 4 to 9                                                                                          | `rewritten` to their `LlamaHttp.test.ts` test                                       |
  | `llamaFetch: a status without a body (204) has a null body`                                                         | `dropped`: an Effect response has no null body                                      |
  | `llamaFetch: streamChatCompletion streams through it…`                                                              | `milestone` becomes `E5`                                                            |
  | the four `downloadFetch:`                                                                                           | `milestone` becomes `E6`                                                            |
  | `logs/lines.test.ts`, `props.test.ts` (2), `logs.test.ts` (2)                                                       | `ported`                                                                            |
  | `proc.test.ts`: pipes and exit code, killed by a signal, cwd and env, a spawn failure throws at once                | `rewritten` to the `Supervisor.test.ts` tests 2, 8, 3, 11                           |
  | `proc.test.ts`: `timeout kills the process with killSignal`                                                         | `rewritten` to the test of `flags/Flags.test.ts` on a `--help` that never ends      |
  | `proc.test.ts`: kill after the exit, the `PATH` diagnosis, the error event after the start, `fileExists`/`readText` | `dropped`: `effect/process` and `FileSystem` own them                               |
  | `proc.test.ts`: `which looks the binary up in the PATH`                                                             | `milestone` becomes `E7` (the bench hardware is its first user)                     |
  | `proc.test.ts`: the two `fileRange`                                                                                 | `milestone` becomes `E6` (the downloader is its first user)                         |
  | `routes.test.ts` (`/props` not JSON)                                                                                | `rewritten` to `supervisor/http.test.ts`                                            |
  | `args.test.ts` (15)                                                                                                 | `ported` to `command.test.ts` (11) and `shell.test.ts` (4); the env one `rewritten` |
  | `external.test.ts`: `no external server is detected while a benchmark owns the port`                                | `milestone` becomes `E7`                                                            |
  | `external.test.ts`: `after a crash, …`                                                                              | `rewritten` to `ExternalWatch.test.ts`                                              |
  | `supervisor.test.ts`: `stop() leaves no timer…`                                                                     | `rewritten` to `Supervisor.test.ts` test 6                                          |

- [ ] **Step 3: Defects and deviations.** In `defects.md`: the row of `lib/setup.ts:61` moves to E8; under "Changed by
      the Effect server", one line per call at the top of this plan (the launchpad's milestone, strict `profileId` and
      `since`, the direct probes, the tagged errors) and one per deviation found while porting.
- [ ] **Step 4: Conventions.** Add to `conventions.md`, from the code as it now is (a few lines each): a long-lived
      process (its own scope, the readers joined before it closes, the exit by signal, the stop in two signals, an
      operation that outlives its request); state shared by several fibers (one function that changes and publishes);
      `LlamaHttp` (its own tag, scoped requests, why not `HttpClient.HttpClient`); tests on real time
      (`excludeTestServices`, durations as layer options, `testing/llama.ts`); the tiers of `Services` and what the
      order of the finalizers guarantees; a scoped background loop (`ExternalWatch`).
- [ ] **Step 5: Legacy files.** Delete (`git rm`) what this milestone rewrote: `app/server-legacy/lib/supervisor/`,
      `lib/logs/`, `lib/profiles/remove.ts`, `lib/runtime.ts`, `routes/api/server/`, `routes/api/state.get.ts`,
      `routes/api/logs.get.ts`. Keep `lib/llamaFetch.ts` and its test (E5 and E6 still read them), `lib/proc.ts` and
      its test (E6 and E7), `lib/setup.ts`, `routes/api/launchpad.get.ts`, `lib/boot.ts`, `lib/context.ts`,
      `lib/deps.ts`. Nothing outside the folder may depend on them. Delete nothing else there.
- [ ] **Step 6: Run everything, commit.**
      `pnpm lint && pnpm check && pnpm test && pnpm build && node scripts/smoke.ts`, then
      `pnpm check 2>&1 | grep -c 'effect('` (expected `0`), then `pgrep -f fake-llama-server` (expected nothing).
      Commit `chore(poc): Close E3, the supervisor`.
- [ ] **Step 7: Measure, on the clean tree.**
      `node scripts/poc/measure.ts --out docs/superpowers/poc-effect/e3.json`, then
      `pnpm exec biome format --write docs/superpowers/poc-effect/e3.json`, commit `chore(poc): Measure E3`.
- [ ] **Step 8: Report.** What was built per task; every deviation from this plan and why; every place the plan was
      wrong about Effect or the tree; every behaviour dropped, changed or moved; any `@effect-diagnostics` directive
      or override entry (expected: the two shared modules of Task 1); the commands of Task 8 Step 3 and what they
      answered; the numbers of `e3.json` next to `e2.json`; anything left undone.
