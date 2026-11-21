# Effect POC, E7: Bench and sweeps Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring the benchmarks back under the Effect server. That covers:

- one-off `llama-bench` and llama-server trial runs, with their history, cancel, delete and "make a profile from a run";
- the gate that stops the managed llama-server for a run and restarts it with the profile as it is now;
- the sweep engine: a queue of items run one by one, cancel, resume, validate, the best run, and the entry E8's
  `POST /api/sweeps` will call;
- the six `bench-*` and `sweep*` WebSocket messages;
- the refusals the bench owes other domains: the four lifecycle routes, the external watch, the model deletion;
- on the web, the Bench page.

**Architecture:**

- The shared package moves `bench.ts` and `sweep.ts` from zod to Schema. It gets two API groups: `bench` (8 endpoints)
  and `sweeps` (5 endpoints: every sweep route but `POST /api/sweeps`, which is E8's). It also gets the six messages of
  `WsMessage`.
- The server gets one folder, `bench/`, holding:
  - two repositories on `SqlClient`: `BenchRunsRepo` and `SweepsRepo`;
  - the pure parts: the failure of a run, the prompt, the `nvidia-smi` line, the trial's measure;
  - `BenchHardware`: the build of the binary, the CPU, the device listing with its last good list, `which`;
  - the gate, on `Supervisor`;
  - the executor: `llama-bench` or a trial llama-server in a followed program, its VRAM and disk samplers, its cancel;
  - `BenchRunner`: one scoped service whose state sits in one `SynchronizedRef`. Its runs and sweep loop are forked in
    the layer's scope. It publishes through `WsHub.publish` and has a shutdown step that leaves the work `interrupted`
    for the next start.

**Tech Stack:**

- Effect 4.1.4: `effect`, `effect/http-api`, `effect/sql`, `effect/process` (`ChildProcess`), `SynchronizedRef`,
  `Semaphore`, `Cache`, `Stream`, `TestClock`.
- `@effect/platform-node`: `NodeServices`, `NodeFileSystem`.
- Vitest 5, `@effect/vitest`, Biome, Playwright (the look).
- The fakes `testdata/fake/fake-llama-bench` and `fake-llama-server`, already in the tree.

**Spec:** `docs/superpowers/specs/2026-11-14-effect-server-design.md`, E7 row.

- Acceptance list: `docs/superpowers/poc-effect/behaviours.md`, section E7, with its `From E3:` and `From E6:` lines.
- Rules: `docs/superpowers/poc-effect/conventions.md`.
- Defects to decide: `docs/superpowers/poc-effect/defects.md`, "E7: bench and sweeps", and the `~` line of
  `lib/tuning/memo.ts:16`.

**Calls made by this plan** (the author's; each is recorded by Task 10):

- **`POST /api/sweeps` moves to E8 (the user's decision, 2026-11-15).** Creating a sweep needs `planSweep`, the memory
  estimator and the tuning hardware (`app/server-legacy/lib/tuning/{space,models,estimate,placement,hardware}.ts`),
  which E8 ports. Its page, Tuning, is E8's too.
  - E7 ports and tests the whole engine: `BenchRunner.startSweep` (below), the loop, cancel, resume, validate, the best
    run, the repositories, and the five other sweep routes.
  - The ported runner tests create their sweeps through `startSweep`, as E8's handler will.
  - Task 10 moves the endpoint's line, its `404 vs 400` defect and its "not covered" line to the E8 section as
    `From E7:` lines.
- **`BenchRunner.startSweep` is the one entry of a sweep run:**
  `startSweep({ files, stopServer, check?, prepare }) → Effect<Sweep, …>`.
  - Under the claim it checks `files` (model and projector), then runs `check` (its refusals leave nothing stopped).
  - Then it takes the gate and runs `prepare`, which writes the rows and returns the sweep's id. A failure of
    `prepare` releases the gate.
  - Then it sets the sweep `running` with `finishedAt` null, publishes `sweep`, and forks the loop.
  - Users of the entry:
    - resume: `check` = "an interrupted or queued item exists", `prepare` = requeue the interrupted ones;
    - validate: `prepare` = requeue the interrupted ones, then enqueue the top `n`;
    - E8's create: `prepare` = create the sweep and its items in one transaction.
- **A claim is atomic and undone on exit.**
  - `start` and `startSweep` claim the runner in one `SynchronizedRef.modify`: 409 `BenchRunning` when it is busy,
    claimed otherwise.
  - The claim covers the file checks, the gate, the hardware read (a `--version` of up to 5 s) and the row writes.
  - The claim is released by `Effect.ensuring`, and only the forked run or loop holds the runner after that.
  - HTTP handlers are interruptible: a client that leaves between its claim and its fork leaves no claim. If the gate
    was taken, its release runs too (`Effect.onInterrupt`), so llama-server comes back.
  - The run or the loop is forked in the layer's scope (`Effect.forkIn(scope)`), never in the request's.
- **`busy` = a claim, a current run, a running sweep, or the gate held.**
  - It is read by: the lifecycle routes' 409, `ExternalWatch`, the model deletion, and E8's disk speed.
  - `BenchRunner` exposes it as `busy: Effect<boolean>`, and `files` (the model and projector of the current run and of
    the running sweep) for the model check.
- **The gate is a module of the runner, on `Supervisor`, not a service of its own.** It is
  `makeGate({ supervisor, ring, stoppingTimeout })` inside the runner's layer, with its state in a `Ref`.
  - `acquire`:
    - polls a `stopping` server every 100 ms, up to `stoppingTimeout` (60 s): 409
      `llama-server is taking too long to stop: try again`;
    - `external`: 409 `An external llama-server is running on port <port>: stop it first`;
    - a server `starting`/`ready` without `stopServer`: 409 `ServerRunning` (code `server-running`);
    - with `stopServer`, it pushes `[bench] stopping llama-server for the benchmark`, keeps the stopped command, and
      **forks** `supervisor.stop` in the runner's scope (`Supervisor.stop` waits for the stop; the legacy gate started
      it without awaiting).
  - `ready` joins that fiber; its failure becomes the run's `could not stop llama-server: <msg>`.
  - `release(rebuild)`:
    - idempotent;
    - pushes `[bench] restarting llama-server (<name>)`;
    - runs `supervisor.start` of the command rebuilt from the profile as it is now (#39), or of the recorded one when
      the profile is gone;
    - a failure pushes `[bench] could not restart llama-server: <msg>` and is returned to the caller, who appends it to
      the run's error.
  - The restart goes through `start`, so `defaultProfileId` is not touched.
- **The bench's processes are `followProgram`s (`app/server/process/followed.ts`), stopped the supervisor's way.**
  - A cancel sends `SIGTERM` (`handle.kill({ killSignal: 'SIGTERM' })`), waits `killTimeout`, then pushes
    `[llama-webui] not stopped after <ms> ms, SIGKILL` and sends `SIGKILL`, as `Supervisor.ts:381-387`.
  - The 1 s `CLOSE_BOUND` of `followProgram` is only the last bound of its scope.
  - `killTimeout` is an option of `BenchRunner.layerWith`: 5 s in the app, 1 s in the tests.
  - Every argv starts `setpriv --pdeathsig KILL --`.
- **Shutdown (`Shutdown.before`)** works in this order, as `Downloads`:
  1. it sets `closing`;
  2. it interrupts the current run's fiber and the sweep loop: the child is SIGKILLed through its scope;
  3. it writes the current run `interrupted` (error `interrupted (llama-webui stopped)`, kept when it had one) and its
     running sweep `interrupted`.

  It publishes nothing and does not release the gate. With `closing` set, the interrupted fibers skip the release path
  (no restart of llama-server while the app stops) and every write.
  - The defect "`dispose()` broadcasts nothing" becomes `design choice`: the hub closes every client with 1001 right
    after, and a client that reconnects reads the rows.
  - At its build, the layer marks the orphans: runs `running` → `interrupted` (COALESCE of the error), sweeps
    `running` → `interrupted`. This happens before any request is served.
- **The runner sits in a tier of its own** in `App.ts`, between `ExternalWatch` (which reads `busy`) and the tier of
  `Monitor`, `Placement`, `ChatRuns` and `Downloads`. It reads `Monitor.latest` for `allGpus` and the model disk's
  `readBps`.
  - Its finalizer runs before the monitor's and the supervisor's. Its shutdown step is registered after the hub's, so
    it runs before the hub's.
  - `BenchRunsRepo` and `SweepsRepo` join the repositories' tier. `BenchHardware` joins `Flags`' tier.
  - `app/server/testing/services.ts` mirrors this, with `BenchRunner.layerWith({ killTimeout: '1 second', pause:
    '10 millis', … })`. `pause` is the pause between two sweep items: 1 s in the app.
- **The trial llama-server talks through `LlamaHttp`, never `fetch`.**
  - `/health` is polled every 500 ms with a 10 min loading bound.
  - The warm-up is `/completion` with `n_predict` 16 and the sentence prompt.
  - Then `r` chat requests with the legacy body: `cache_prompt: false`, `temperature: 0`, `seed: 42`, `stream: false`,
    `ignore_eos`, `chat_template_kwargs { enable_thinking: false }`.
  - Each request waits 10 min at most (`no response after 10 min`); any other status reads `<path> responded <status>`.
  - The result is the mean and population stddev, and the draft acceptance rounded to 0.1.
  - The port is the `port` setting on `127.0.0.1`; one that answers before the start is `port <port> is used by
    another server`.
  - `app/server-legacy/lib/llamaFetch.ts` and its test are deleted at Task 10: nothing references them after E7.
- **Defects, decided:**
  - **resume stops llama-server before answering 409 Nothing to resume** → `confirmed`, `fixed in E7`. The check is
    `startSweep`'s `check`, before the gate. Test `resuming a sweep with nothing to resume is a 409 and stops nothing`.
  - **`restarting-server` never broadcast at the end of a sweep** → `confirmed`, `fixed in E7`. The loop keeps the last
    item's live until the release: `bench-progress` with phase `restarting-server` and step null, then null. Test
    `the end of a sweep shows restarting-server while llama-server comes back`.
  - **cancelling an unknown run id answers 409** → `confirmed`, `fixed in E7`.
    - An id with no row: 404 `Run not found`.
    - A row that is not the current run: 409 `This run is not running`, as today.
    - The same rule applies to sweeps: a missing sweep is 404 `Sweep not found`, as today.
    - Recorded as changed.
  - **`DELETE /api/sweeps/:id` broadcasts even when nothing was deleted** → `confirmed`, `fixed in E7`. The delete runs
    in one transaction that returns whether the row existed and the run ids it took. A sweep gone between the look-up
    and the delete answers 404, with nothing broadcast.
  - **`dispose()` broadcasts nothing** → `design choice` (above).
  - **`POST /api/sweeps` answers 404 Model not found where run/resume/validate answer 400** → moved to E8 with the
    endpoint (`From E7:`).
  - **`~` not expanded in `lib/tuning/memo.ts:16`** → the E7 half is `fixed in E7`: every bench binary
    (`benchBinary` of `llamacpp-js/node`, `--list-devices`, `--version`) is taken from the `binary` setting after
    `expandHome`. The memo half stays E8's.
- **Requests:**
  - `GET /api/bench/runs` stays lenient. Its query schema is optional strings only, and a pure
    `runFilters(query) → RunFilters` keeps today's reading: an unknown `kind` or `status` ignored, `sweep` absent or
    unknown = one-off runs, `limit` positive integers only, capped at 10,000, default 200 or 10,000 for a sweep id. A
    strict query would turn those into 400s the page never sends; recorded as `design choice`.
  - `DELETE /api/bench/runs` takes `failed: Schema.Literal('1')`: any other or missing value is `RequestInvalid` 400
    `Invalid data: ?failed=1 expected (failed)`. Recorded as changed (was a 400 with the bare message), as E6's queries.
  - `POST /api/sweeps/:id/resume` keeps its schema-less body: payload `Schema.Record(Schema.String, Schema.Unknown)`,
    and only `stopServer === true` counts. A body that is not an object is `RequestInvalid` 400, as since E2.
  - `validate` is strict: `{ n: Int 1–5, default 3, stopServer?: Boolean }`.
  - `POST /api/bench/run` takes `{ spec: BenchSpec, stopServer?: Boolean }`, strict.
  - The payload is decoded before the handler runs. A bad body on an unknown or running sweep is now a 400 where it was
    the 404 or 409 of the look-up. Recorded as changed, the conventions' rule.
  - Every `:id` is `IdParam`: a bad id is 404 `RouteNotFound` `Unknown route` (was `Run not found` / `Sweep not
    found` / `Profile not found`), as E2 to E6.
- **Errors are tagged** in `@llama-webui/shared`, messages word for word:

  | Tag                     | Status | Message                                                                                             |
  | ----------------------- | ------ | --------------------------------------------------------------------------------------------------- |
  | `BenchRunning`          | 409    | `A benchmark is running`                                                                            |
  | `BenchFileMissing`      | 400    | `Model not found: <path>` / `Projector not found: <path>`                                           |
  | `ServerStopTooSlow`     | 409    |                                                                                                     |
  | `ExternalServerRunning` | 409    |                                                                                                     |
  | `ServerRunning`         | 409    | `llama-server is running (profile <name>): it will be stopped during the benchmark, then restarted` |
  | `RunNotFound`           | 404    | `Run not found`                                                                                     |
  | `RunStillRunning`       | 409    | `This run is still running: cancel it first` (delete), `This run is still running` (to-profile)     |
  | `RunNotRunning`         | 409    |                                                                                                     |
  | `SweepNotFound`         | 404    |                                                                                                     |
  | `SweepStillRunning`     | 409    | `This sweep is still running: cancel it first`                                                      |
  | `SweepNotRunning`       | 409    |                                                                                                     |
  | `NothingToResume`       | 409    |                                                                                                     |
  | `NothingToValidate`     | 409    | `No successful run to validate`                                                                     |
  - `ProfileNotFound` and `ProfileNameTaken` are reused.
  - `BenchRunning` joins `ServerApi`'s `start`, `switch`, `restart` and `stop`: after the 404 of an unknown profile on
    start and switch, before anything else on restart and stop.
  - `ModelInUse` takes the message `A benchmark in progress uses it` (the `From E6:` line), and `blocked` in the usage
    reads `BenchRunner.files` too.
  - The web tells the refusals by `_tag`: `BenchForm`'s `server-running` becomes `ServerRunning`.
- **The messages** are new members of `WsMessage`, published through `WsHub.publish`, with the timing rules of
  `behaviours.md` E7 "WebSocket messages":
  - `bench-progress` (`NullOr(BenchLive)`), at most every 250 ms, its phases and the 20 last lines;
  - `bench-run` (`BenchRun`), `bench-deleted` (`{ ids }`);
  - `sweep-progress` (`NullOr(SweepLive)`), `sweep` (`Sweep`), `sweep-deleted` (`{ id }`).
  - The web consumes the `bench-*` three in E7; the `sweep*` three have no consumer until E8 (`onWs` is keyed by type,
    and an unheard message is dropped).
- **Hardware:**
  - `buildOf(binary)` reads `--version` (5 s), matches `/build (\d+), commit (\w+)/` → `b<n> (<commit>)`, and is cached
    by path and mtime (`Cache.makeWith`, failures not kept).
  - The CPU is `readCpuInfo` of `app/server/hardware/cpu.ts`, read once.
  - The device listing has a 15 s timeout, per-binary `lastGood`, the GPU-backend regex, and the two failure messages.
    It is a service, `BenchHardware`, so E8's tuning hardware and setup reuse it.
  - `which(name)` looks a name without `/` up in `PATH` (read through `Config`) with `FileSystem.access` (executable).
- **No new `@effect-diagnostics` directive is expected.**
  - The VRAM probe reads AMD sysfs through `FileSystem` and runs `nvidia-smi -lms 100` as a followed program.
  - The disk sampler reads `Monitor.latest`.
  - Any directive this plan did not foresee is a stop-and-report.

## Global Constraints

- Branch `poc/effect`, after `docs(poc): Plan E7, the bench and the sweeps`. Commit on it; the controller pushes.
- **Before writing any Effect code, read `repos/effect/LLMS.md` completely**, then
  `docs/superpowers/poc-effect/conventions.md`, then the reference files of the task. `repos/effect` is the installed
  version (4.1.4): read it, not `node_modules`, and never edit it.
- **Effect diagnostics are blocking:** `pnpm check 2>&1 | grep -c 'effect('` prints `0`, warnings included.
  - The only change of `tsconfig.effect.json`: `packages/webui-shared/src/bench.ts` and
    `packages/webui-shared/src/sweep.ts` join the third override (Task 1).
  - `tuning.ts` is not touched (E8).
  - No new `@effect-diagnostics` directive. Any rule that seems wrong for a piece of code: stop and report, do not
    lower it.
- Idiomatic Effect only (conventions):
  - services are `Context.Service` classes keyed `@llama-webui/app/server/<path>/<Name>`, with their layers as statics;
  - methods are `Effect.fn('Service.method')`;
  - errors are `Schema.TaggedError<X, { readonly X: unique symbol }>()`, built with `X.make(…)`;
  - time comes from `Clock`, SQL goes through `SqlClient`, files through `FileSystem`, processes through
    `effect/process`, configuration through `Config`.
- Promise code wrapped in `Effect.promise` does not count as ported.
- `app/server-legacy/` is a read-only reference: port behaviour, not structure; never import it. Only Task 10 deletes
  files in it. `lib/bench/hardware.ts` stays for E8: `routes/api/setup.get.ts` imports `buildOf` and `listDevices`,
  and `lib/tuning/hardware.ts` imports `listDevicesResult`.
- A reply carries what is stored: its schema has no input rule (conventions, "Replies"). `BenchRun.spec` decodes what
  a Nitro-written `args_json` holds, and `hardware_json` `'{}'` reads as no hardware.
- Server and shared code runs under Node as it is: relative imports end in `.ts`, erasable syntax only.
- No dependency is added. zod stays in the catalog (`tuning.ts` and E8 still use it) but leaves `bench.ts` and
  `sweep.ts`.
- **Never start anything on port 7860 or 7861**, nor on the default data folder, nor on the user's models folder or
  binary. Tests never use port 8080 and never run a real `llama-bench`, `llama-server` or `nvidia-smi`:
  - the `binary` setting is a fake: `testdata/fake/fake-llama-server`, whose bench sibling by `benchBinary` is
    `testdata/fake/fake-llama-bench`. That fake reads its outputs from `testdata/llama-bench/`
    (`fake-llama-bench.ts:15`). Add a fixture under `app/server/testing/fixtures/` if a test needs another layout;
  - `PATH` is set by the test when it matters;
  - the trial port is a free one.
- A test that starts a process asserts it is dead at the end. Throttles and pauses are tested on the `TestClock`
  (`TestClock.adjust`). Tests on real processes use `layer(L, { excludeTestServices: true })`.
- Code, comments, test names, messages and commits in English. Commits end with
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- `pnpm lint`, `pnpm check` and `pnpm test` are green at the end of every task.
  - Before Task 1, run `pnpm test` once and record every test that already fails on the clean tree. The report lists
    them; they are not counted.
  - `pnpm test` stops before `llamacpp-js` when Vitest fails, so `pnpm --filter llamacpp-js test` is run on its own.
  - Zero Biome warning. Format a Markdown or JSON file you wrote with `pnpm exec biome check --write <file>`.
- **Gates of every task:** `pnpm lint`, `pnpm check`, the task's tests (`pnpm exec vitest run <files>`), and
  `pnpm check 2>&1 | grep -c 'effect('` printing `0`.

## Facts verified on this tree

- **Tables:** they exist and no migration is added.
  - `bench_runs`, AUTOINCREMENT (`app/server/db/migrations.ts:143-170`, `0010`–`0015`), columns: id, kind, status,
    model_path, profile_id, args_json, command, hardware_json, pp_tps, tg_tps, stats_json, vram_mib_json, error,
    log_excerpt, duration_ms, sweep_id (`ON DELETE CASCADE`), sweep_label, fit, created_at.
  - `sweeps` (`0009`): id, name, status, model_path, profile_id, spec_json, best_run_id (`ON DELETE SET NULL`),
    created_at, finished_at.
- **Supervisor** (`app/server/supervisor/Supervisor.ts:90-108`): `state`, `lastCommand: Option<BuiltCommand>`, `start(cmd)`
  (errors `OperationInProgress | ServerAlreadyRunning | PortInUse`), `stop` (waits for the operation in progress, then
  stops), `detectExternal`, `recheckExternal`.
  - Its stop is SIGTERM, then `[llama-webui] not stopped after <ms> ms, SIGKILL`, then SIGKILL (`:381-387`).
  - `Supervisor.layer` = `killTimeout: '5 seconds'`, `healthPoll: '500 millis'` (`:483`).
- **Commands:** `buildCommand({ profile, settings })` and `profilePaths({ profile, home, cwd, path })` are in
  `app/server/supervisor/command.ts:47`, `:117`. `BuiltCommand` has `profileId` and `profileName`. `expandHome` and
  `homeDir` are in `app/server/config/Home.ts`. `benchBinary(serverBinary)` is in `packages/llamacpp-js/src/node.ts:64`.
- **ExternalWatch** (`app/server/supervisor/ExternalWatch.ts`) is a module (`layerWith({ interval })`), not a service;
  its `check` reads `Supervisor` and `SettingsRepo`. The pause becomes a `BenchRunner.busy` read at the head of
  `check`.
- **Model usage:** `modelUsage` and `deleteModel` (`app/server/models/usage.ts:47`, `:155`) compute `blocked` from the
  running profile and `ActiveWrites`. The bench check is added beside them.
- **Monitor and processes:**
  - `Monitor.latest: Effect<Snapshot | null>` (`app/server/monitor/Monitor.ts:102`); `Snapshot.allGpus` and
    `Snapshot.disk.model.readBps` are in `packages/webui-shared/src/monitor.ts:137`, `:195`. `Monitor.layerStub`'s
    `latest` is null.
  - `followProgram({ command, parent, name, onSpawn?, read, onExit? })` → `Followed { handle, scope, stop, ended }`
    (`app/server/process/followed.ts:45-63`).
  - `linesOf(bytes)` (`app/server/logs/lines.ts:16`); `LogRing.push(text)` (`app/server/logs/LogRing.ts:27`).
- **HTTP clients and probes:** `LlamaHttp` (`app/server/llama/LlamaHttp.ts`) and `health(target)`
  (`app/server/llama/probes.ts:23`, 800 ms).
- **Router:** the `HttpRouter` is a port of find-my-way. A static child is tried before a parametric one
  (`repos/effect/packages/effect/src/http/FindMyWay/internal/router.ts:615`, `:673-716`), so `DELETE /api/bench/runs`
  is not read as `DELETE /api/bench/:id`. Task 8 has a test for it.
- **Shared modules:**
  - `bench.ts` (zod, 308 lines) and `sweep.ts` (zod, 171 lines) are exported by `export *` in
    `packages/webui-shared/src/index.ts`.
  - `tuning.ts` holds types and pure functions only (no zod): `bench.ts` imports `FitVerdict` from it, `sweep.ts`
    imports `NOISE`, `PRESET_IDS`, `presetOf`.
  - Outside their own tests, no module calls `.parse`, `.safeParse` or `z.infer` on their schemas (`grep -rn` over
    `app/src` and `packages`): the E8 pages compile against the types alone.
- **The web:**
  - `/bench` is in `MILESTONE_BY_PATH` (`app/src/app/routes.ts`), as `E7`.
  - `app/src/lib/bench.ts` (393 lines) still calls the deleted `api('…')`.
  - `app/src/features/bench/*` import `@/lib/bench`, `@/lib/profiles`, `@/lib/server`, `@/features/models/ModelPicker`.
    `BenchHistory` reads `?run=<id>` (from Tuning).
  - `app/src/lib/ws.ts` dispatches by `onWs(type, fn)`.
  - `lib/tuning.ts` and `features/tuning/*` (E8) import types of `bench.ts` and `sweep.ts`.
- **Test helpers:**
  - `app/server/testing/llama.ts` has `FAKE`, `freePort`, `pidAlive`, `until`, `killFromOutside`.
  - The fakes read `FAKE_BENCH_OOM`, `FAKE_BENCH_OOM_ARG`, `FAKE_PP`, `FAKE_TG`, `FAKE_TG_BY_ARG`, `FAKE_BENCH_STEP_MS`
    (bench) and `FAKE_LOAD_MS`, `FAKE_SLOW_ARG`, `FAKE_FAIL_ARG`, `FAKE_EXIT_LINES`, `FAKE_ECHO_ENV` (server).
- **Contract:** the suite sets `binary` to the fake then to a missing program (`app/server/contract/cases.ts:190-195`),
  under a `HOME` of its own with one model (`contract.test.ts:31-72`).
- `scripts/poc/measure.ts` takes `--out` and `--skip-durations`.
- **Test inventory:** `test-inventory.json` has 50 `E7` entries:
  - from `lib/bench/runner.test.ts` (16), `gate.test.ts` (2), `hardware.test.ts` (4), `parse.test.ts` (1) and
    `vram.test.ts` (1);
  - from `lib/db/benchRuns.test.ts` (2) and `sweeps.test.ts` (4);
  - `lib/proc.test.ts` `which` (1), `lib/routes.test.ts` `GET /api/bench/runs caps…` (1) and
    `lib/supervisor/external.test.ts` (1);
  - `app/src/lib/bench.test.ts` (2), and the shared `bench.test.ts` (8) and `sweep.test.ts` (7).
- **Legacy references:**
  - The supervisor's lifecycle 409: `git show e876da9cf:app/server-legacy/lib/supervisor/control.ts`.
  - The models' bench check: `git show 5cd7ebe17:app/server-legacy/lib/models/access.ts` (`benchFiles`: the live run's
    and the running sweep's model and projector).

## Reference files

- **Legacy behaviour** (read, never import), under `app/server-legacy/`:
  - `lib/bench/{runner,gate,execute,server,hardware,vram,parse,prompt}.ts` and their tests;
  - `lib/db/{benchRuns,sweeps}.ts` and their tests, `lib/sweeps/access.ts`;
  - `routes/api/bench/**`, `routes/api/sweeps/**` (`index.post.ts` read for `startSweep`'s E8 use only);
  - `lib/deps.ts:77-101` (the executor's and the runner's wiring), `lib/boot.ts` (orphans, the watch's pause, the order);
  - the bench cases of `lib/contract/cases.ts`.
- **Models in the Effect server:**
  - `app/server/downloads/Downloads.ts`: a queue forked in the layer's scope, one `SynchronizedRef`, a semaphore, a
    shutdown step with `closing`, the publishes.
  - `app/server/chat/ChatRuns.ts`: orphans at the build.
  - `app/server/supervisor/Supervisor.ts`: a followed program, SIGTERM then SIGKILL.
  - `app/server/collectors/nvml/` (`Collectors.ts`): a child read by lines.
  - `app/server/flags/Flags.ts`: a `Cache.makeWith` whose failures are not kept.
  - `app/server/downloads/DownloadsRepo.ts` and `app/server/chat/ConversationsRepo.ts`: repositories, JSON columns
    through `Schema.fromJsonString`.
  - `app/server/downloads/http.ts` and `packages/webui-shared/src/api/DownloadsApi.ts`: a group and its errors.
  - `app/src/lib/downloads.ts`: a store on `call`, fed by `onWs`.

## Review Focus

- **A client that leaves mid-request** (a tab closed while `POST /api/bench/run` waits for `--version`, or for the
  stop): the runner is not left busy, the gate is released, and llama-server is restarted if it was stopped. Test:
  Task 6, `a request interrupted between its claim and its start leaves the runner free and llama-server back`.
- **The app is stopped mid-benchmark** (Ctrl-C during a sweep):
  - the stop takes less than 2 s, the child is gone, llama-server is not restarted;
  - the run and the sweep are `interrupted` in the database;
  - the next start lists them, and the sweep resumes.

  Tests: Task 6, `dispose (shutdown) saves the running sweep item and its sweep as interrupted`; Task 8,
  `SIGTERM during a benchmark ends it interrupted and kills llama-bench` in `app/server/lifecycle.test.ts`.
- **llama-server comes back after a benchmark**:
  - with the profile as it is now (#39), or the recorded command when the profile is gone;
  - even when `llama-bench` fails;
  - a failed restart is written on the run;
  - at a sweep's end, once, with `restarting-server` shown.

  Tests: Task 4 (the two #39 tests), Task 6 (`restarts the server it stopped even when llama-bench fails`, `a failed
  restart is recorded on the run`, `a sweep stops the server once, continues after an OOM item and restarts it once`,
  `the end of a sweep shows restarting-server while llama-server comes back`).
- **Cancel**: SIGTERM, then SIGKILL after the timeout with its ring line; a sweep moves on to its next item; a
  cancelled sweep ends `cancelled` with its best run. Tests: Task 5, `a cancel sends SIGTERM, then SIGKILL after the
  timeout`; Task 6, `cancelSweep cancels the queue and releases the gate`.
- **Two clicks on Run** (or two tabs): the second request gets 409 `A benchmark is running` and the gate is taken once.
  So does a lifecycle route while a run is busy. Tests: Task 6, `a successful run stores pp/tg and refuses a second run
  meanwhile`; Task 7, `the server routes answer 409 A benchmark is running while the runner is busy`.
- **The trial server is not taken for an external one**: no `external` state while a benchmark owns the port. Test:
  Task 7, `no external server is detected while a benchmark owns the port`.

---

### Task 1: Schemas, the two groups and the messages

**Files:**

- Modify:
  - `packages/webui-shared/src/bench.ts`, `packages/webui-shared/src/sweep.ts`, and their tests `bench.test.ts`,
    `sweep.test.ts`;
  - `packages/webui-shared/src/ws.ts`;
  - `packages/webui-shared/src/api/Api.ts` (`.add(BenchApi).add(SweepsApi)` after `DownloadsApi`, before
    `.middleware`);
  - `packages/webui-shared/src/api/ServerApi.ts` (`BenchRunning` on the four lifecycle endpoints);
  - `packages/webui-shared/src/models.ts` (if `ModelInUse` lives there; else its file);
  - `packages/webui-shared/src/index.ts`;
  - `tsconfig.effect.json` (the third override).
- Create:
  - `packages/webui-shared/src/api/BenchApi.ts`, `packages/webui-shared/src/api/SweepsApi.ts`;
  - `packages/webui-shared/src/api/bench.test.ts` (the groups' query and payload rules).

**Interfaces:**

- `bench.ts` (Schema, the same fields as today's interfaces and zod schemas):
  - kept by name: `CACHE_TYPES`, `SPLIT_MODES`, `FLASH_ATTN`, `FIELD_ORDER`, `OOM_ERROR`, `isOomError`,
    `serverArgsField`, `paramsFromServerArgs`, `ctxFromArgs`, `withCtx`, `serverArgs`, `benchArgs`, `ignoredByBench`;
  - Schemas `BenchParams` (strict, the field rules of `behaviours.md`), `BenchKind`, `BenchStatus`, `BenchSpec` (strict,
    the defaults, `serverArgs` refusing reserved flags and field-covered flags at their index), `Measure`,
    `BenchHardware`, `BenchRun`, `BenchPhase`, `BenchLive`, `BenchDevice`;
  - reply-side twins of a schema with input rules where a reply must decode stored data (conventions, "Replies").
    `BenchRun.spec` is the reply form.
- `sweep.ts`:
  - kept by name: `expandSpace`, `itemLabel`, `sweepCtx`, `scoreOf`, `rankRuns`, `estimatedSweepSeconds`;
  - Schemas `SweepSpace` (each field a non-empty list, message `at least one value`), `SweepSpec` (strict; `name`
    trimmed 1–80), `SweepStatus`, `Sweep`, `SweepLive`, `Ranked` (type).
- The old names `BenchSpecSchema`, `BenchParamsSchema`, `SweepSpecSchema` and `SweepSpaceSchema` are removed. The tests
  decode with `Schema.decodeUnknownExit`.
- `ws.ts`: members `bench-progress` (`NullOr(BenchLive)`), `bench-run` (`BenchRun`), `bench-deleted` (`{ ids:
  Array(Int) }`), `sweep-progress` (`NullOr(SweepLive)`), `sweep` (`Sweep`), `sweep-deleted` (`{ id: Int }`).
- `BenchApi` (`bench`):

  | Name           | Route                             | Input                                                              | Reply                     | Errors                                                                                            |
  | -------------- | --------------------------------- | ------------------------------------------------------------------ | ------------------------- | ------------------------------------------------------------------------------------------------- |
  | `devices`      | `GET /api/bench/devices`          |                                                                    | `Array(BenchDevice)`      |                                                                                                   |
  | `fromProfile`  | `GET /api/bench/from-profile/:id` |                                                                    | `BenchDraft`              | `ProfileNotFound`                                                                                 |
  | `runs`         | `GET /api/bench/runs`             | query optional strings `kind`, `status`, `model`, `sweep`, `limit` | `{ runs, live }`          |                                                                                                   |
  | `deleteFailed` | `DELETE /api/bench/runs`          | query `failed: Literal('1')`, message `?failed=1 expected`         | `{ deleted: Int }`        |                                                                                                   |
  | `run`          | `POST /api/bench/run`             | payload strict `{ spec: BenchSpec, stopServer?: Boolean }`         | `BenchRun`, `status(202)` | `BenchRunning`, `BenchFileMissing`, `ServerStopTooSlow`, `ExternalServerRunning`, `ServerRunning` |
  | `remove`       | `DELETE /api/bench/:id`           |                                                                    | `NoContent`               | `RunNotFound`, `RunStillRunning`                                                                  |
  | `cancel`       | `POST /api/bench/:id/cancel`      |                                                                    | `NoContent`               | `RunNotFound`, `RunNotRunning`                                                                    |
  | `toProfile`    | `POST /api/bench/:id/to-profile`  |                                                                    | `Profile`, `status(201)`  | `RunNotFound`, `RunStillRunning`, `ProfileNameTaken`                                              |

  `BenchDraft` is `{ modelPath, mmprojPath, profileId, params, serverArgs }`.
- `SweepsApi` (`sweeps`):

  | Name       | Route                           | Input                               | Reply                  | Errors                                                                                                        |
  | ---------- | ------------------------------- | ----------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------- |
  | `list`     | `GET /api/sweeps`               |                                     | `{ sweeps, live }`     |                                                                                                               |
  | `get`      | `GET /api/sweeps/:id`           |                                     | `{ sweep, runs }`      | `SweepNotFound`                                                                                               |
  | `remove`   | `DELETE /api/sweeps/:id`        |                                     | `NoContent`            | `SweepNotFound`, `SweepStillRunning`                                                                          |
  | `cancel`   | `POST /api/sweeps/:id/cancel`   |                                     | `NoContent`            | `SweepNotFound`, `SweepNotRunning`                                                                            |
  | `resume`   | `POST /api/sweeps/:id/resume`   | payload `Record(String, Unknown)`   | `Sweep`, `status(202)` | `SweepNotFound`, `SweepStillRunning`, `BenchRunning`, `BenchFileMissing`, the gate's three, `NothingToResume` |
  | `validate` | `POST /api/sweeps/:id/validate` | payload strict `{ n, stopServer? }` | `Sweep`, `status(202)` | resume's, `NothingToValidate` instead of `NothingToResume`                                                    |

  There is no `create` (E8).

- [ ] **Step 1: Port and write the failing tests.**
  - `bench.test.ts`: the eight tests of the inventory, same names. The schema ones decode with
    `Schema.decodeUnknownExit` and assert the failure's message and path.
  - `sweep.test.ts`: the seven, same names.
  - `api/bench.test.ts`:
    - `the runs query accepts any string and the deleteFailed query refuses anything but 1`;
    - `a BenchRun with a Nitro-written spec and empty hardware decodes`;
    - `the validate payload defaults n to 3 and refuses an unknown key`;
    - `every new endpoint is in the API definition` (`HttpApi.reflect` lists the fourteen `METHOD /path`).
- [ ] **Step 2:** they fail.
- [ ] **Step 3: Implement.**
  - Move both modules, add the groups, the errors, the members and the override entries.
  - `index.ts` keeps `export *`.
  - Fix the compile of `app/src` with the smallest changes (the type names). Record any change of a page E8 owns.
- [ ] **Step 4:** the gates, plus `pnpm exec vitest run packages/webui-shared`.
- [ ] **Step 5:** Commit `feat(shared): Describe the bench and the sweeps with Schema`.

### Task 2: The two repositories

**Files:**

- Create: `app/server/bench/BenchRunsRepo.ts`, `app/server/bench/SweepsRepo.ts` and their tests.

**Interfaces:**

- `BenchRunsRepo`:
  - `create({ spec, command, hardware, status, sweepId?, label?, fit? })`: `profile_id` through a subselect, null for a
    missing profile;
  - `enqueue(sweepId, items)` (one transaction), `begin(id, { command, hardware })`, `nextQueued(sweepId)`;
  - `requeue(id)`, `requeueInterrupted(sweepId)` (results cleared), `cancelQueued(sweepId)`;
  - `finish(id, result)`;
  - `list(filters: RunFilters)` (the order of `behaviours.md`; `MAX_RUNS` 10,000), `get(id)` → `Option`;
  - `lastOkByProfile` (for E8), `delete(id)` → whether a row went, `deleteFailed` → ids (`RETURNING id`);
  - `stopOrphans`.
- `SweepsRepo`:
  - `create(spec)`, `get(id)` → `Option<Sweep>` (counts by status, total, best summary), `list`;
  - `setStatus(id, status, { finishedAt?, bestRunId? })`;
  - `delete(id)` → `Option<{ runIds }>` in one transaction (none when the row was gone);
  - `running`, `stopOrphans`.
- `RunFilters` and the pure `runFilters(query)` live in `BenchRunsRepo.ts`.
- SQL rules (conventions, "SQL"): integers bound through `CAST(? AS INTEGER)` where the column compares, JSON columns
  through `Schema.fromJsonString`, `SqlError` mapped by `reason`.

- [ ] **Step 1: Port the failing tests.** The six inventory tests, same names, on `Db.layerAt(':memory:')`; the J5
      migration test on the fixture of the legacy test (copy what it builds into `app/server/db/fixtures/` if it reads
      a file). Add:
  - `runFilters ignores unknown values, caps limit at 10,000 and defaults it to 200 or 10,000 for a sweep`;
  - `GET /api/bench/runs caps an explicit limit at the sweep default, 10,000 (#37)`: the inventory test, ported as a
    `runFilters` and `list` test here, its HTTP half in Task 8;
  - `deleteFailed deletes only one-off failed, cancelled and interrupted runs and returns their ids`;
  - `deleting a sweep that is gone returns none`.
- [ ] **Step 2:** they fail.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** the gates.
- [ ] **Step 5:** Commit `feat(server): Store the bench runs and the sweeps`.

### Task 3: The pure parts and the hardware

**Files:**

- Create:
  - `app/server/bench/parse.ts` (`benchFailure`), `app/server/bench/prompt.ts` (`promptOf`, `STORY`,
    `WARMUP_PROMPT`);
  - `app/server/bench/vram.ts` (`parseSmiLine`, and the probe of Task 5 later);
  - `app/server/bench/measure.ts` (mean, population stddev, draft %);
  - `app/server/bench/which.ts`, `app/server/bench/BenchHardware.ts`;
  - their tests.

**Interfaces:**

- `BenchHardware`:
  - `build(binary)` → `string | null`;
  - `devices(benchBinary)` → `{ devices, error }`, and `listDevices(benchBinary)` → `devices` only;
  - `hardware(gpus)` → `BenchHardware` (cpu, gpus, build of the expanded `binary` setting).
- `BenchHardware.layerWith({ listTimeout, versionTimeout })`; `layer` = 15 s and 5 s.
- `which(name)` → `Option<string>`.

- [ ] **Step 1: Port the failing tests.**
  - The inventory's `hardware.test.ts` (4), `parse.test.ts` (1), `vram.test.ts` (1) and `which looks the binary up in
    the PATH`, same names, on fake binaries written to a temp folder (a script that prints a `--version` line, one
    that lists devices, one that crashes).
  - Add:
    - `the listing of a binary that is not there is no devices with the spawn's message`;
    - `promptOf repeats the paragraph up to four characters per token`;
    - `measure is the mean and the population stddev`.
- [ ] **Step 2:** they fail.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** the gates.
- [ ] **Step 5:** Commit `feat(server): Read the bench hardware`.

### Task 4: The gate

**Files:**

- Create: `app/server/bench/gate.ts`, `app/server/bench/gate.test.ts`.

**Interfaces:**

- `makeGate({ stoppingTimeout, poll? })` → `Effect<Gate, never, Supervisor | LogRing | Scope>`, with:
  - `held: Effect<boolean>`, `stoppedCommand: Effect<Option<BuiltCommand>>`;
  - `acquire({ stopServer })` (errors `ServerStopTooSlow | ExternalServerRunning | ServerRunning`);
  - `ready` (fails with the stop's message);
  - `release(rebuild: (stopped) => Effect<Option<BuiltCommand>>)` → `Effect<void, RestartFailed>`, where
    `RestartFailed { message }` is internal and not on the wire.

- [ ] **Step 1: Port the failing tests,** on the real `Supervisor` of `ServicesTest` with the fake llama-server:
  - the two inventory tests, same names (#39);
  - `an external server is a 409 that names its port`;
  - `a running server without stopServer is a 409 ServerRunning that names the profile`;
  - `a stop that takes longer than the timeout is a 409 and the gate stays free` (on the `TestClock`, poll 100 ms);
  - `the gate pushes its two [bench] lines and its failure line to the ring`;
  - `release without a stop does nothing and twice is once`.
- [ ] **Step 2:** they fail.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** the gates.
- [ ] **Step 5:** Commit `feat(server): Gate llama-server for a benchmark`.

### Task 5: The executor

**Files:**

- Create:
  - `app/server/bench/execute.ts` (`commandOf(spec)`, `runBench`, `runServer`);
  - `app/server/bench/trial.ts` (the trial llama-server on `LlamaHttp`);
  - the VRAM probe in `vram.ts`;
  - `app/server/bench/execute.test.ts`, `app/server/bench/trial.test.ts`.

**Interfaces:**

- `execute({ spec, onLive, killTimeout })` runs in the caller's scope. It returns the run's result, the same fields as
  the legacy one: pp/tg, stats, `vramPeak` (MiB rounded, > 0 only), `logExcerpt` (50-line tail), `durationMs`,
  `diskReadPeakBps`.
- `onLive` gets phase, step and the 20 last lines; throttling is the runner's.
- A `cancel` handle: SIGTERM, then the ring line and SIGKILL after `killTimeout`.
- The command:
  - **bench:** `setpriv --pdeathsig KILL -- <benchBinary(expanded binary)> -m … -o json --progress -r -p -n …benchArgs`,
    display `shellQuote` of the argv after `--`;
  - **server:** a synthetic profile through `buildCommand`, its env = the settings' then the source profile's, its cwd
    the source profile's.

- [ ] **Step 1: Port the failing tests,** on the fakes:
  - from the inventory's `runner.test.ts`, the executor-level ones, same names:
    - `a server run measures r times and reports draft acceptance`;
    - `a bench run gets its profile's environment`;
    - `a server that dies of OOM is reported as OOM even when a long backtrace follows the allocation error`;
    - `the warm-up prompt is a sentence: a 2-token prompt crashes llama-server with -sm tensor and an MTP draft`;
    - `a server run runs in its profile's directory`;
    - `the VRAM sampler takes its last reading when the run ends, then stops`.
  - Add:
    - `a llama-bench run parses its progress into steps and its JSON into pp and tg`;
    - `a cancel sends SIGTERM, then SIGKILL after the timeout` (a fake that ignores SIGTERM: add
      `app/server/testing/fixtures/ignoresTerm.ts` if none exists; the ring line asserted; the process dead);
    - `a trial on a port already in use fails with port <port> is used by another server`;
    - `a request that gets another status fails with <path> responded <status>`;
    - `the bench binary is taken from the binary setting with ~ expanded`.
- [ ] **Step 2:** they fail.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** the gates; `pgrep -f fake-llama` prints nothing.
- [ ] **Step 5:** Commit `feat(server): Run llama-bench and llama-server trials`.

### Task 6: The runner

**Files:**

- Create: `app/server/bench/BenchRunner.ts`, `app/server/bench/BenchRunner.test.ts`.

**Interfaces:**

- `BenchRunner`:
  - `busy`, `live`, `sweepLive`, `files`;
  - `start(spec, { stopServer })` → `BenchRun`;
  - `startSweep({ files, stopServer, check?, prepare })` → `Sweep`;
  - `resume(id, { stopServer })` and `validate(id, { n, stopServer })` → `Sweep`, on `startSweep`;
  - `cancel(id)` (`RunNotFound | RunNotRunning`), `cancelSweep(id)` (`SweepNotFound | SweepNotRunning`).
- `BenchRunner.layerWith({ killTimeout, pause, stoppingTimeout, liveThrottle })`; `layer` = 5 s, 1 s, 60 s, 250 ms.
- Depends on `BenchRunsRepo`, `SweepsRepo`, `BenchHardware`, `Supervisor`, `ProfilesRepo`, `SettingsRepo`, `Monitor`,
  `LogRing`, `WsHub`, `LlamaHttp`, `Shutdown`, and the platform.
- The best run: validated server runs if any is ok, else the bench runs, through `rankRuns` with the preset and
  `sweepCtx`.

- [ ] **Step 1: Port the failing tests.**
  - The ten remaining runner tests of the inventory, same names, on `ServicesTest` with the fakes:
    - `restarts the server it stopped even when llama-bench fails`;
    - `a successful run stores pp/tg and refuses a second run meanwhile`;
    - `a missing model is refused before anything stops`;
    - `a failed restart is recorded on the run`;
    - `dispose (shutdown) saves the running sweep item and its sweep as interrupted` (through `Shutdown.run`);
    - `a sweep stops the server once, continues after an OOM item and restarts it once`;
    - `cancelSweep cancels the queue and releases the gate`;
    - `validating an interrupted sweep also finishes its interrupted items`;
    - `server validation runs get the sweep context when the profile sets no -c (#24)`;
    - `resuming a sweep whose model was deleted is one 400, before anything stops (#37)`.
  - The sweeps are made through `startSweep` with a `prepare` that writes them (E8's shape).
  - Add:
    - `a request interrupted between its claim and its start leaves the runner free and llama-server back` (Review
      Focus: a fiber interrupted while the gate's stop runs);
    - `resuming a sweep with nothing to resume is a 409 and stops nothing`;
    - `the end of a sweep shows restarting-server while llama-server comes back`;
    - `cancelling an unknown run is a 404, a run that is not current a 409`;
    - `the sweep loop pauses between items` (`TestClock`);
    - `bench-progress is throttled to one message per 250 ms and carries the 20 last lines` (`TestClock`);
    - `the orphans of the last run are interrupted when the layer is built`;
    - `busy covers the claim, the run, the sweep and the gate`.
- [ ] **Step 2:** they fail.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** the gates; `pgrep -f fake-llama` prints nothing.
- [ ] **Step 5:** Commit `feat(server): Run benchmarks and sweeps in the background`.

### Task 7: The wiring and the other domains' refusals

**Files:**

- Modify:
  - `app/server/App.ts` (the tiers of the Calls), `app/server/testing/services.ts`;
  - `app/server/supervisor/ExternalWatch.ts`, `app/server/supervisor/http.ts`;
  - `app/server/models/usage.ts`;
  - their tests: `ExternalWatch.test.ts`, `supervisor/http.test.ts`, `models/http.test.ts`.

**Interfaces:**

- `check` of `ExternalWatch` returns at once while `BenchRunner.busy`.
- The four lifecycle handlers read `busy` first: after the profile's 404 for start and switch.
- `modelUsage` adds `A benchmark in progress uses it` when one of `BenchRunner.files` is one of the model's. The order:
  the running server first, then the benchmark, then a download. Read the legacy `access.ts`/`delete.ts` for the
  order.

- [ ] **Step 1: Write the failing tests.**
  - `no external server is detected while a benchmark owns the port` (inventory, same name);
  - `the server routes answer 409 A benchmark is running while the runner is busy` (the four, start and switch after
    an unknown profile's 404);
  - `a model a benchmark or a running sweep opens is blocked, and its deletion a 409`.
- [ ] **Step 2:** they fail.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** the gates, plus the whole `app/server` project (`pnpm exec vitest run --project server`).
- [ ] **Step 5:** Commit `feat(server): Hold llama-server, the watch and the models during a benchmark`.

### Task 8: The handlers, the contract and the lifecycle

**Files:**

- Create:
  - `app/server/bench/http.ts` (`BenchHandlers`, `SweepsHandlers`);
  - `app/server/bench/http.test.ts`;
  - `app/server/bench/toProfile.ts` (the naming and the args of a profile made from a run, pure where it can be).
- Modify:
  - `app/server/http/HttpLive.ts`;
  - `app/server/contract/cases.ts`, `golden.json`;
  - `app/server/lifecycle.test.ts`.

**Interfaces:**

- Each handler is a thin call to the runner or the repositories.
- `deleteFailed` and `remove` publish `bench-deleted` when ids went. `DELETE /api/sweeps/:id` publishes
  `bench-deleted` (even an empty list), then `sweep-deleted`, only when the row went.
- `toProfile`:
  - the name `<stem> — bench #<id>`, then ` (2)`…;
  - `cwd` = `modelsDir` as typed, the model and projector through `profileModelPath`;
  - the args through `serverArgs` + `withCtx` / `sweepCtx` (#24);
  - the env of the source profile.
- `fromProfile` uses `profilePaths` and `paramsFromServerArgs`.

- [ ] **Step 1: Write the failing tests.**
  - `http.test.ts`, over raw HTTP on the built routes:
    - the HTTP half of `GET /api/bench/runs caps an explicit limit at the sweep default, 10,000 (#37)`;
    - `DELETE /api/bench/runs is not read as a run id`;
    - `deleteFailed refuses anything but failed=1 and publishes the ids it deleted`;
    - `a run's delete is a 404 for a missing one, a 409 for a running one, and publishes bench-deleted`;
    - `to-profile names the profile after the model and the run, then (2), and copies the source's env`;
    - `to-profile adds the sweep context to a sweep item's flags when they set none (#24)`;
    - `from-profile splits the profile's args and resolves its files against its cwd`;
    - `a sweep's delete publishes its run ids, then the sweep, and a running one is a 409`;
    - `resume reads stopServer only when it is true`;
    - `validate refuses n out of 1–5 and an unknown key`.
  - Contract cases, after the `binary: a program that is not there` case:
    - `GET /api/bench/devices` (read: `[]`), `GET /api/bench/runs`, `GET /api/sweeps` (empty);
    - `GET /api/bench/from-profile/999999`, `DELETE /api/bench/999999`, `POST /api/bench/999999/cancel`,
      `POST /api/bench/999999/to-profile` (refusal 404);
    - `DELETE /api/bench/runs` (violation) and `DELETE /api/bench/runs?failed=1` (write `{ deleted: 0 }`);
    - `POST /api/bench/run` with `{}` (violation), and with a valid spec of a missing model (refusal 400);
    - `GET`, `DELETE /api/sweeps/999999`, `POST /api/sweeps/999999/cancel`, `/resume`, `/validate` (refusal 404).

    Record them with `UPDATE_GOLDEN=1 pnpm exec vitest run app/server/contract/contract.test.ts`, then read the diff of
    `golden.json`: new cases only, plus those that move from the 404 of a missing route to the bench's answers.
  - `lifecycle.test.ts`: `SIGTERM during a benchmark ends it interrupted and kills llama-bench` (Review Focus).
    - The build, with `binary` the fake through the settings and `FAKE_BENCH_STEP_MS` long.
    - A run posted, then SIGTERM: exit 0 in under 2 s, the fake bench's pid dead.
    - The row `interrupted` with `interrupted (llama-webui stopped)` in the data folder's database.
- [ ] **Step 2:** they fail.
- [ ] **Step 3: Implement** the handlers and the wiring.
- [ ] **Step 4:** the gates; `pnpm build` before the build-driven suites.
- [ ] **Step 5:** Commit `feat(server): Serve the bench and the sweeps`.

### Task 9: The Bench page

**Files:**

- Modify:
  - `app/src/lib/bench.ts`, `app/src/lib/bench.test.ts`;
  - `app/src/features/bench/*.tsx`;
  - `app/src/app/router.tsx`, `app/src/app/routes.ts`;
  - the golden's entry modulepreload list.

**Interfaces:**

- Consumes the client's `api.bench.*` through `call` (`app/src/lib/api.ts`), `errorTag`, and the three `bench-*`
  messages through `onWs`.
- Produces `makeBenchStore(calls)` (as `makeDownloadsStore`), with `useBench`, `startBenchSync`, `KIND_LABEL`,
  `PHASE_LABEL`, `STATUS_LABEL`, `splitArgs` and the form types kept by name for E8's Tuning page.

- [ ] **Step 1: Write the failing tests.**
  - The two inventory tests of `app/src/lib/bench.test.ts`, same names.
  - `run posts the spec and stopServer and adds the run`.
  - `a bench-run, bench-progress or bench-deleted message updates the store`.
  - `a ServerRunning refusal is told by its tag and offers to stop the server`.
  - `deleteFailed sends failed=1`.
- [ ] **Step 2: Implement.**
  - Move the store to `call`.
  - The form's `server-running` check becomes the `ServerRunning` tag.
  - Put `/bench` in `PORTED` and out of `MILESTONE_BY_PATH`.
  - The Tuning pages stay as they are (E8) as long as they compile.
- [ ] **Step 3:** `pnpm check`, the web tests, `pnpm build`; the golden's modulepreload list re-recorded and read.
- [ ] **Step 4: Look at the page.** The build on a scratch data folder and a scratch `HOME` with `models/` holding a
      `writeGguf` model, a free port, Chromium (Playwright, `deviceScaleFactor: 1`).
  - Set the `binary` setting to `testdata/fake/fake-llama-server` (its bench sibling is `fake-llama-bench`), and a
    profile on the fake.
  - Check:
    - a llama-bench run that progresses then completes;
    - a server run with a managed server running: the `ServerRunning` dialog, then stop-and-restart;
    - a cancel, the history's filters, a delete, a delete-failed;
    - "create profile from run", "bench from profile";
    - no console error.
  - Screenshots go in the session's scratchpad; every process is stopped at the end.
- [ ] **Step 5:** the gates.
- [ ] **Step 6:** Commit `feat(web): Bring the Bench page back`.

### Task 10: Close the milestone

**Files:**

- Modify: `docs/superpowers/poc-effect/behaviours.md`, `test-inventory.json`, `defects.md`, `conventions.md`,
  `CLAUDE.md` (only a rule a contributor needs that changed).
- Delete:
  - under `app/server-legacy/lib/bench/`: `runner.ts`, `gate.ts`, `execute.ts`, `server.ts`, `vram.ts`, `parse.ts`,
    `prompt.ts` and every `*.test.ts`, keeping `hardware.ts` for E8;
  - `lib/db/benchRuns.ts`, `lib/db/sweeps.ts` and their tests, `lib/sweeps/access.ts`;
  - `routes/api/bench/`, every file of `routes/api/sweeps/` but `index.post.ts` (E8);
  - `lib/llamaFetch.ts` and its test.

  First build the delete list from `grep -rn` of what the E8 files (`lib/tuning/*`, `lib/setup.ts`,
  `routes/api/setup.get.ts`, `routes/api/tuning/**`, `routes/api/sweeps/index.post.ts`) import. Keep what they import,
  and record it.
- Create: `docs/superpowers/poc-effect/e7.json`.

- [ ] **Step 1: Behaviours.** Section E7:
  - Every line is ticked with its proof (test file and name, or contract case), in the format of E1 to E6.
  - A changed line says how it behaves now (the calls of this plan).
  - Every "Not covered by a test" line is ticked with the test this plan added, or with its decision.
  - The `From E3:` and `From E6:` lines are ticked (Task 7).
  - `POST /api/sweeps`, its defect, and the parts of the "not covered" lines that need it move to the E8 section as
    `From E7:` lines (the endpoint on `BenchRunner.startSweep`, its 404 vs 400 to decide, its wiring to test).
- [ ] **Step 2: Tests.** The fifty `E7` entries of `test-inventory.json` get a status (a throwaway script in the
      scratchpad, never regenerated):
  - `ported` with its new place;
  - `rewritten` with its new place: the `routes.test.ts` limit test (→ `bench/BenchRunsRepo.test.ts` and
    `bench/http.test.ts`) and the executor-level runner tests (→ `bench/execute.test.ts`);
  - `dropped` with a reason, only where no rewrite exists (expected: none).

  The script checks that every E7 entry has a status and prints the count by status.
- [ ] **Step 3: Defects and deviations.** `defects.md` section E7 gets the verdicts of the Calls. Under "Changed by
      the Effect server" goes one line per call of this plan and per deviation found while porting:
  - the unknown run's 404;
  - resume's check before the gate;
  - the `restarting-server` phase at a sweep's end;
  - the lenient runs query, `?failed=1` as `RequestInvalid`;
  - bad ids as the unknown route, the body decoded before the look-up;
  - `POST /api/sweeps` moved to E8.
- [ ] **Step 4: Conventions.** From the code as it is:
  - a claim taken in one `SynchronizedRef.modify` and released by `ensuring`, the work forked in the layer's scope (a
    request that leaves mid-way);
  - a process stopped with an escalation (SIGTERM, `killTimeout`, SIGKILL with its ring line) beside
    `followProgram`'s close;
  - a gate that holds another service for a while and gives it back.

  `CLAUDE.md`: the `poc/effect` note says the bench goes through `BenchRunner` (`app/server/bench/`), its trial
  through `LlamaHttp`, and that `llamaFetch`/`downloadFetch` are gone.
- [ ] **Step 5: Legacy files.** `git rm -r` the files listed above. Check with `grep -rn` that nothing kept for E8
      imports a deleted file other than `lib/deps.ts`, `lib/boot.ts` and the legacy `contract/` (as after E6).
- [ ] **Step 6:** Run every final check:
  - `pnpm lint && pnpm check && pnpm test && pnpm build && node scripts/smoke.ts`;
  - `pnpm --filter llamacpp-js test`;
  - `pnpm check 2>&1 | grep -c 'effect('` prints 0;
  - `pgrep -f fake-llama` prints nothing.

  Commit `chore(poc): Close E7, the bench`.
- [ ] **Step 7:** Run `node scripts/poc/measure.ts --out docs/superpowers/poc-effect/e7.json --skip-durations` (the
      times are taken by hand in the report, as E6), format the file, and commit `chore(poc): Measure E7`.
- [ ] **Step 8: Report.** It covers:
  - per task, what was built;
  - every deviation and why, and every place the plan was wrong;
  - every behaviour dropped, changed or moved;
  - directives and override entries: expected none, and `bench.ts` and `sweep.ts` in the third override;
  - what Task 9 Step 4 showed;
  - the tests that already failed before Task 1;
  - `e7.json` next to `e6.json`;
  - anything left undone.
