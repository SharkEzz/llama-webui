# Effect POC, E8: Tuning and setup Implementation Plan

> Implemented inline by the main session (no subagent, the user's instruction of 2026-11-15). Steps use checkbox
> (`- [ ]`) syntax for tracking.

**Goal:** Bring back, under the Effect server:

- the tuning endpoints: checks, hardware, disk speed, estimate, plan;
- the creation of a sweep (`POST /api/sweeps`), on `BenchRunner.startSweep` (E7);
- the first-run report (`GET /api/setup`) and the launchpad (`GET /api/launchpad`);
- on the web: the Home page (launchpad and setup checklist), the Tuning page, the Checks card of System, and the "Run
  setup again" button of Settings.

**Architecture:**

- Shared package:
  - `tuning.ts` and `setup.ts` move to Schema (into the third override of `tsconfig.effect.json`);
  - two new groups, `TuningApi` (5 endpoints) and `SetupApi` (`setup`, `launchpad`);
  - `create` is added to `SweepsApi`.
- Server: one folder, `app/server/tuning/`:
  - the pure modules, rewritten under the server's rules (Effect's `Array`, `Option`, `String`, strict booleans) with
    the same results: `memory.ts`, `placement.ts`, `estimate.ts`, `match.ts`, `space.ts` (the plan), `checks.ts`;
  - the reads, around them:
    - `sysinfo.ts`: `readSys` on `FileSystem`, `Path` and the spawner;
    - `models.ts`: `loadModel` and `mmprojBytes` on `GgufReader`;
    - `disk.ts`: the measure, on `FileSystem.stream` with `offset` and `bytesToRead`;
  - three services:
    - `TuningHardware`: the devices with live memory, the CPU read once, RAM from the snapshot or `/proc/meminfo`;
    - `TuningMemo`: the last estimate and disk measure per model path, for the checks;
    - the handlers of `tuning` and `setup` in `tuning/http.ts` and `tuning/setup.ts`.
- No WebSocket message, no shutdown step, nothing persisted.

**Spec:** `docs/superpowers/specs/2026-11-14-effect-server-design.md`, E8 row; `behaviours.md` § E8 (every line is a
requirement of this plan).

## Calls

1. **The estimator is rewritten, not copied** (the server's diagnostics refuse native array methods and implicit
   booleans). To show the rewrite gives the same answers, beyond the ported tests, Task 3 ends with a **differential
   run**:
   - The legacy `lib/tuning/` and its imports are copied out of the tree with `git show` into the session's
     scratchpad. They are never imported by the repository.
   - Legacy and new `estimate`, `measurePlacement`/`fitOf`, `planSweep` and `runChecks` run on the same inputs. The
     outputs are compared field by field.
   - The inputs:
     - the fixtures of the legacy tests;
     - a generated grid: every preset, device sets of 0 to 3 cards across CUDA, Vulkan and ROCm, MoE and dense
       models, pinned `dev`, `ngl`, `ncmoe`, `fa`, `ctk`, `ub` and `ctx`;
     - the GGUF headers of the models on this machine, read only.
   - The deliberate deviations (Call 6) are the only differences allowed, each one named. The script and its counts
     are recorded in the closing commit's message, and the script itself stays out of the tree.
2. **Where the state lives:**
   - The memos (estimates, disk measures) are a service, `TuningMemo`: two `Ref`s of `HashMap`s keyed by model path,
     built with the runtime. A route reload no longer exists, so "survives a route save" is moot.
   - The CPU info is `Effect.cached` inside `TuningHardware`.
   - The `--list-devices` and `--version` caches stay `BenchHardware`'s (E7).
3. **Errors** (tags, statuses, messages kept):
   - The model loading of estimate, plan, disk speed and sweep creation:
     - `ModelPathInvalid` 400 `Expected an absolute path to a .gguf file` (new, `TuningApi.ts`);
     - `ModelNotFound` 404 `Model not found` and `ModelUnreadable` 422 (the GGUF message), both of `ModelsApi.ts`;
     - `ProjectorNotFound` 404 `Projector not found` (new).
   - The disk speed:
     - `BenchRunning` 409 `A benchmark is running: the measurement would be skewed` (its own message);
     - `ModelFileNotFound` 404 `File not found: <path>`;
     - `FileTooSmall` 400 `File too small to measure (<n> MiB)` (new).
   - The creation: `NothingToRun` 409 `No configuration to run: <n> excluded by the estimator` (new, `SweepsApi.ts`),
     then the runner's `StartError`s.
4. **`POST /api/sweeps` reads the model like `POST /api/tuning/plan`** (the 404 vs 400 defect, `defects.md` E7):
   - It loads the GGUF to plan, before the runner, and answers the loading errors of the plan (400 path, 404 `Model
     not found`, 422, 404 `Projector not found`). Run, resume and validate parse no GGUF and keep the 400
     `BenchFileMissing`. This is recorded as a design choice: the creation is a plan that starts.
   - The exclusions are the runner's `check` (`NothingToRun`), run under the claim. So a busy runner now answers its
     409 `A benchmark is running` before `No configuration to run`. This is a recorded change of order.
   - `prepare` creates the sweep and enqueues its items in one `sql.withTransaction`.
   - The body is `{ spec: SweepSpec, stopServer?: boolean }`, decoded strictly at the edge. An issue's path then starts
     with `spec` (`Invalid data: required (spec.name)`), as for a run's `spec` since E7. This is recorded in the list
     of changes.
5. **The plan body** is `{ spec: SweepSpec }`, decoded at the edge like any payload. A body without `spec` is the 400
   `RequestInvalid` with path `spec` (was a message without a path). A contract case sends it (the unverified E8
   defect: confirmed and closed by the case).
6. **Defects of E8, verified while writing this plan:**
   - `lib/tuning/memo.ts:16` (`~` not expanded for `llama-bench`): **fixed**, `TuningHardware` expands the setting
     like `GET /api/bench/devices`. Test: `the tuning hardware lists the devices of a ~/… binary`.
   - `lib/setup.ts:61` (`buildOf` gets the raw setting): **fixed**, the report passes the expanded binary. Test:
     `the setup report reads the version of a ~/… binary`.
   - The plan's V cache default `ctv ?? ctk ?? f16`, where llama.cpp (and the estimator) default `-ctv` to f16 whatever
     `-ctk` is: **confirmed** (`llama-bench` and `llama-server` take `-ctv f16` unless told otherwise; an item
     `-ctk q8_0` was measured with a q8_0 V cache it does not get). **Fixed**: the plan measures with the
     estimator's `cacheOf`. Test: `a plan item pinned -ctk q8_0 is measured with an f16 V cache`.
   - The PCIe and Resizable BAR checks run for a card that is not kept: **design choice** (the link and the BAR say
     something about the machine whatever the profile uses), ported as is.
   - `amd.rocm-gfx` is always `unknown`: **design choice** (rocminfo is not run), ported as is.
   - The `git log` of the build date has no timeout: bounded to 5 s like every program of the server
     (conventions, "Programs"), a timeout gives `null`. This is a recorded change.
7. **Not ported:** nothing. The legacy tests of `fileRange` (E8 in the inventory) become the tests of the disk
   measure's range read (`[start, end)`, 1 MiB chunks).

## Global Constraints

- Read `repos/effect/LLMS.md` and `docs/superpowers/poc-effect/conventions.md` before code.
- `app/server-legacy/` and `repos/` are read only. Legacy files are deleted at the end of their task's port, never
  imported.
- Tests and trials:
  - use a scratch data folder and a free port, never 7860, 7861 or 8080, and never `~/.local/share/llama-webui`;
  - use the fakes of `testdata/fake/` for `llama-bench` and `llama-server`;
  - never run a real `llama-bench`, `llama-server` or `nvidia-smi`.
- `pnpm lint`, `pnpm check` (0 `effect(` lines) and `pnpm test` all green at the end of each task that touches code.
- English in code, comments, tests and commits. Commit messages end with
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Tasks

### Task 1: Schemas and groups

- [ ] `packages/webui-shared/src/tuning.ts` to Schema:
  - `Fit`, `DeviceBudget`, `TuningHardware`, `Recommendation`, `Estimate`, `PlanItem`, `PlanResult`, `Check`,
    `ChecksReport`, `DiskSpeed`, `PresetId` (literals);
  - numbers are `Finite` or `Int` (conventions, "Finite numbers");
  - `PRESETS`, `presetOf`, `deviceRole`, `gpuDevices`, `isSetupCheck` stay functions, rewritten under the server's
    rules (the module joins the third override).
- [ ] `setup.ts` to Schema: `SetupReport`, `LaunchpadEntry`, plus `isLoopback`.
- [ ] `EstimateRequest`: `{ modelPath: NonEmptyString, mmprojPath?: NullOr(String), preset, pinned?: BenchParams, ctx?:
  Int 512..10_000_000 }`, strict. `DiskSpeedRequest`: `{ modelPath: NonEmptyString }`.
- [ ] `TuningApi`:
  - `checks` (query `model?`), `hardware`, `diskSpeed`, `estimate`, `plan`;
  - the errors of Call 3.
- [ ] `SetupApi`: `setup`, `launchpad`.
- [ ] `SweepsApi.create`: payload `{ spec: SweepSpec, stopServer?: Boolean }`, 202 `{ sweep, items, excluded }`.
- [ ] Barrel exports, checked for name clashes (conventions).
- [ ] Schema tests: the shared `setup.test.ts` entries of the inventory, and a decode test of each request.

### Task 2: The pure tuning modules

- [ ] Port, under `app/server/tuning/`:
  - `memory.ts`: `KV_BYTES`, `holdsKv`, `kvLayerBytes`, `computeBytes`, `marginBytes`, `budgetBytes`, `fmtBytes`;
  - `placement.ts`: `measurePlacement`, `fitOf`;
  - `match.ts`: `matchGpus`, `retainedBusIds`, `withLiveMemory`;
  - `estimate.ts`: `estimate`;
  - `space.ts`: `planSweep`, with the V cache fix of Call 6;
  - `checks.ts`: `runChecks`, `summarize`.
- [ ] Multi-parameter exports take one options object or `dual` (`missingPipeableSignature`).
- [ ] Port their legacy tests (estimate 13, placement 9, match 3, checks 4, from the inventory) as plain
      `describe`/`it` tests (conventions, "A pure step"). Add tests for the lines of "Not covered by a test" that are
      pure:
  - `--mlock`, `--numa`, the `slow generation` and `everything in RAM` warnings, `model too large`;
  - `invalid -ot pattern`, and the KV of MTP, recurrent and sliding-window layers;
  - hidden and suspended cards, `retainedBusIds` without devices;
  - each NVIDIA, AMD, CPU, build and kernel check state, and `summarize`.

### Task 3: The differential run (Call 1)

- [ ] In the scratchpad:
  - `git show HEAD:app/server-legacy/lib/tuning/<file>` for each module and its imports (`models/sizes.ts`);
  - a runner that imports both sides, generates the grid, reads the GGUF headers of the local models through the
    new `GgufReader` (the same `ModelInfo` feeds both sides), and compares `JSON` of each output.
- [ ] Any difference is either a bug of the port (fixed, with a test) or a Call 6 deviation (listed). Record the
      counts (inputs, outputs equal, deviations).

### Task 4: The reads and the services

- [ ] `tuning/models.ts`: `loadModel(path)` (the 400, 404 and 422 of Call 3, through `GgufReader.read`) and
      `mmprojBytes(path | null)` (0, the size, or 404).
- [ ] `tuning/disk.ts`: `measureDiskSpeed({ path, fileBytes, offsetFraction? })`:
  - up to 1 GiB from a random offset, refused under 64 MiB;
  - read by `fs.stream(path, { offset, bytesToRead, chunkSize: 1 MiB })` and timed with `Clock`;
  - the two `fileRange` inventory tests, on a scoped temporary file.
- [ ] `tuning/sysinfo.ts`:
  - `readSys({ procRoot?, sysRoot?, binary, modelPath, logLines, nvml, busIds })`, every reading tolerant;
  - `resolveBinary` (`which` of `bench/which.ts`, then `realpath`);
  - `git log` under a 5 s timeout;
  - `resolveModelDisk` of `collectors/disk.ts`.
  - Tests on a fake `/proc` and `/sys` tree (scoped temporary folder) for every reading of the "Not covered" list,
    and `resolveBinary` (PATH lookup, relative, symlink, missing).
- [ ] `TuningHardware` service:
  - `read: Effect<TuningHardware>`, from `BenchHardware.devices(benchBinary(expandHome(binary)))` and `withLiveMemory`
    over `Monitor.latest`'s `allGpus`;
  - RAM from `system.mem`, else `parseMeminfo` of `/proc/meminfo`, else 0;
  - the CPU `Effect.cached`.
  - Tests: the `~` fix (Call 6), RAM without a snapshot, `devicesError` passed through.
- [ ] `TuningMemo` service: `estimates` and `diskSpeeds`, `get`/`set` per path.
- [ ] Both into `Services` (`App.ts`) and `ServicesTest`.

### Task 5: The handlers

- [ ] `tuning/http.ts` (`TuningHandlers`):
  - `checks`: hardware, model (`Effect.option`) and `readSys` in parallel; then `runChecks` with the memos, `Monitor`'s
    snapshot and NVML system, `LogRing.since(0)`, `Clock` for `at`;
  - `hardware`;
  - `diskSpeed`: `BenchRunner.busy` first;
  - `estimate`: memoized, also when not ok;
  - `plan`.
- [ ] `tuning/setup.ts` (`SetupHandlers`):
  - `setup`: `buildSetupReport` with `resolveBinary`, `BenchHardware.build` of the expanded binary (Call 6),
    `listDevices`, `scanModels`, `Monitor.nvidiaSource`, `perf_event_paranoid`, `AppConfig.host`;
  - `launchpad`: `ProfilesRepo.list`, `profilePaths`, `loadModel`, `mmprojBytes`, the `fit` estimate, and
    `BenchRunsRepo.lastOkByProfile`. The fit is dropped when there are no devices but there are GPUs. Entries are
    built in parallel, and each one's failure stays in its entry.
- [ ] `SweepsHandlers.create` (Call 4).
- [ ] Into `ApiRoutes` (`http/HttpLive.ts`).
- [ ] HTTP tests (`tuning/http.test.ts`, `tuning/setup.test.ts`, `bench/http.test.ts`):
  - the setup inventory entries (8), including the launchpad's two;
  - the memo round trip (estimate, then disk speed, then checks), the 409 of the disk speed while busy;
  - the loading errors, an unreadable `model` dropped by the checks;
  - the `ctx` bounds and unknown keys;
  - the plan without `spec`;
  - the creation: items with labels and fit, the 202 body, `NothingToRun`;
  - the launchpad's dropped fit.
- [ ] Contract cases for the 8 endpoints, plus `violation` and `refusal` cases:
  - `hardware`, `checks` and `setup` are `{ machine: true }`;
  - then `UPDATE_GOLDEN=1` and read the diff.
- [ ] Delete the legacy files of the domain:
  - `lib/tuning/`, `lib/setup.ts`, `lib/bench/hardware.ts`;
  - the routes `tuning/*`, `setup.get.ts`, `launchpad.get.ts`, `sweeps/index.post.ts`;
  - their tests.

### Task 6: The web

- [ ] `app/src/lib/tuning.ts` and `app/src/lib/setup.ts` move to `call((api) => …)`. An error is told by its `_tag`
      (`ServerRunning` → confirm, as in `lib/bench.ts`). `tuning.test.ts` comes out of the `exclude` of
      `app/tsconfig.json`.
- [ ] `features/tuning/*`, `features/home/**` and `features/system/ChecksCard.tsx` follow the store; `ModelCard.tsx`
      reads `@/lib/models`.
- [ ] `/` and `/tuning` go into `PORTED` and out of `MILESTONE_BY_PATH`. The Checks card goes back into `SystemPage.tsx`,
      and "Run setup again" back into Settings.
- [ ] Check the look against the master build (Playwright, as at E7), on a scratch instance with the fakes.

### Task 7: Close the milestone

- [ ] `behaviours.md` § E8: every line ticked, or a deviation recorded. `defects.md`: Call 6, and a "Found while
      porting" list. Update `test-inventory.json` and the "Changed by the Effect server" lines.
- [ ] `CLAUDE.md`: an E8 paragraph (tuning folder, memo service, `POST /api/sweeps` on the runner).
- [ ] `docs/superpowers/poc-effect/e8.json`, measured like `e7.json`.
- [ ] `pnpm lint`, `pnpm check` (0 `effect(`), `pnpm test`. Commit by task, then a review pass against this plan and
      `behaviours.md`, recorded in `defects.md`.
