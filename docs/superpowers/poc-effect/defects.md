# Defects of the Nitro server found while porting

What the port found wrong, or odd, in the Nitro server (`app/server-legacy/`, the same code as `master`). The
milestone that ports a domain verifies the lines of its section when its plan is written, then:

- a **confirmed defect** is fixed in the Effect server, with a test that names it, and is listed as a deliberate
  deviation in the milestone's section of `behaviours.md`;
- a **design choice** (the behaviour is intended, or changing it is a product decision) is ported as it is;
- a line that turns out **wrong** is struck, with the reason.

Nothing here is fixed on `master`, and no issue is opened: the list is reviewed with the report of E10.

Status: `unverified` (reported by a reader of the code, not reproduced), `confirmed`, `design choice`, `not a defect`,
`fixed in <milestone>`.

## Confirmed

| Where                                      | Defect                                                                                                                                                                                                   | Status    | Ported at |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | --------- |
| `lib/tuning/memo.ts:16`                    | `benchBinary(settings.get().binary)` gets the setting without `~` expanded: with a `~/…` binary the device listing of Tuning fails, and with it `POST /api/sweeps`. `GET /api/bench/devices` expands it. | confirmed | E7, E8    |
| `lib/setup.ts:61`, `lib/bench/hardware.ts` | The raw `binary` setting goes to `buildOf`, which does not expand `~` either: `version` is null in the setup report for a `~/…` binary.                                                                  | confirmed | E8        |

## Reported, to verify with the milestone's plan

### E2: profiles and flags

- Deleting the profile the server is running answers 409 before the 404 of an unknown id is considered. `not a defect`:
  only a profile that exists can be running, so an unknown id never meets the 409 (returns with the supervisor, E3).
- The profile schema is strict and sets no maximum length on the name. `design choice`: the strict schema refuses a
  typo'd key, and a name has no limit to keep; ported as it is (`ProfileInput`).
- The cache of the flags of `--help` is never invalidated. `design choice`: the catalogue is read once per binary path
  per run (a failure is not kept); a rebuilt binary at the same path is read again after a restart (`Flags`).

### E3: supervisor, logs, setup

- `profileId` is coerced with `Number()`: a value of the wrong kind answers 404 instead of a validation error.
  `fixed in E3`: `profileId` is a strict integer, anything else a 400 `RequestInvalid` (`supervisor/http.test.ts`).
- A failed launch still answers 202 and remembers the profile as the last started. `design choice`: the state
  `crashed` carries the message a person acts on, and restart takes the profile once it is fixed; ported as it is.
- A refused start can set the state to `external` before its 409. `design choice`: the start found a llama-server
  on the port, and the state says so (the 409 names its pid); ported as it is.
- A start has no deadline. `design choice`: a large model can load for many minutes, and a stop ends the wait;
  ported as it is (the health poll stays `starting` on a 503).
- `LLAMA_ARG_LOG_VERBOSITY` is only looked for in the environment of the profile and of the settings. `design choice`:
  those are what a person sets for llama-server; ported as it is (`supervisor/command.test.ts`).
- `server-state` is never sent to a client when it connects. `not a defect`: after `hello` the web reads
  `GET /api/state`, on every (re)connection; ported as it is.
- The supervisor calls the global `fetch`: the proxy of the environment applies to its requests to llama-server.
  `fixed in E3`: every request to a llama-server goes through `LlamaHttp`, direct (`llama/LlamaHttp.test.ts`).

### E4: monitor and collectors

- The `Monitor` class has no direct test. `fixed in E4`: the tick is a pure step tested without timers
  (`monitor/tick.test.ts`), and the service on real time, with the fake llama-server and the collectors
  (`monitor/Monitor.test.ts`).
- `Ring.max()` and the `gpus: false` branch are never reached. `confirmed`: `max()` is not ported
  (`monitor/History.ts`), and since no caller sets `gpus: false`, the field is removed from `GpuNeeds` and from the
  `Needs` of the NVML protocol (`collectors/gpu.ts`, `collectors/nvml/protocol.ts`): a card is skipped only by its bus
  id.
- An NVML child that fails once it is ready is never started again. `design choice`: a sampler that failed on this
  machine would fail again, and its readings are cleared at once rather than left stale; ported as it is, and a line
  on its stdout that is not a message ends it the same way (`collectors/nvml/Nvml.test.ts`: a sampler that exits
  after ready clears its readings for good; a sampler that writes a line that is not a message is dead for good, and
  killed).
- `collectors.nvml` is only read at startup. `design choice`: NVML or nvidia-smi is chosen when the collectors start;
  ported as it is (`collectors/Collectors.test.ts`: collectors.nvml is read at startup only).

### E5: chat

- The comment of `stopOrphans` says "interrupted", the code writes "stopped". `unverified`
- `liveIds()` is never called. `unverified`
- Stopping an unknown id answers 409. `unverified`

### E6: models and downloads

- `GET /api/models/info` reads any absolute path that ends in `.gguf`, outside the models folder too. `unverified`
- Two 409 answers can only be reached in a race. `unverified`
- Deleting a model deletes its files before its profiles. `unverified`
- No test posts a valid download. `unverified`

### E7: bench and sweeps

- Resume stops and restarts llama-server before it answers 409 `Nothing to resume`. `unverified`
- In `runner.ts`, the `setLive` after the loop of a sweep is never reached: `restarting-server` is never broadcast
  during a sweep. `unverified`
- `POST /api/sweeps` answers 404 `Model not found` where run, resume and validate answer 400. `unverified`
- Cancelling an unknown run id answers 409. `unverified`
- `DELETE /api/sweeps/:id` broadcasts even when it deleted nothing. `unverified`
- `dispose()` broadcasts nothing. `unverified`

### E8: tuning, topology, launchpad

- The default of the V cache type differs: the plan uses `ctv ?? ctk ?? f16`, the estimator `ctv ?? f16`. `unverified`
- The PCIe and Resizable BAR checks ignore whether the card is kept. `unverified`
- `amd.rocm-gfx` is always `unknown`. `unverified`
- A plan body without `spec` is never replayed by the contract suite. `unverified`

## Changed by the Effect server (not defects)

Recorded in the E1 section of `behaviours.md`.

Decided (the E1 plan, or accepted with its result):

- A wrong method on a known `/api` path and `HEAD` answer 404 `RouteNotFound` (was 405 with `Allow`, and HEAD as GET).
- A body that is not a JSON object answered a bare 400 at E1 (was `Invalid JSON` / `JSON object expected`); since E2 it is
  a 400 `RequestInvalid` with its `issues` (`Invalid data: Expected a valid JSON body`).
- A usage error of the command line exits 1 with the help (was 2).

Decided (user): a path under `/api/` and `/ws/` that ends with a slash is a 308 to the path without it, query string
kept, after the guard (which judges `/ws` itself only: `/ws/` is redirected unjudged, its target guarded) (was 404; at E1 the router of `effect/http` ignored the slash). The UI's paths keep theirs.

Decided (the E2 plan): requests are validated by their schema at the edge.

- On `PUT /api/profiles/:id` an invalid body is a 400 even when the profile does not exist (was 404 first).
- An id that is not a positive integer answers 404 `RouteNotFound` `Unknown route` (was `Profile not found`).
- A body that is not JSON answers `Invalid data: Expected a valid JSON body`, an empty one `Invalid data: Expected object`
  on a profile payload and `Invalid data: Expected JSON value` on the import, which takes any JSON (was `Invalid JSON`).
- An unknown key answers `unknown key` and comes first among the issues (zod worded it its own way, after the fields).
- The `code` of an error (`name-taken`) is its `_tag` (`ProfileNameTaken`).

Found while porting E2, accepted with its result:

- `POST /api/profiles/:id/duplicate` copies the stored profile as it is, without validating it again (was a 400
  `Invalid data: …` for a stored profile that no longer passes the schema).
- An item of an import that is not an object is explained as `Expected object` (was zod's own message).
- A stored profile that the input rules now refuse (an argument that became reserved after it was saved) is listed,
  read, exported and copied as it is; saving it again answers the 400 that names the argument. Nitro did the same
  except for the copy (above).

Decided (user, 2026-11-14): the llama-tui import is not ported (llama-tui was never deployed beyond the user): its two
endpoints, the `llamaTuiImportDismissed` setting and the import banner are dropped. The generic import still reads a
`{ profiles }` file, and `duplicate` still turns a `llama-tui` source into `import`.

Decided (the E3 plan):

- The launchpad (`GET /api/launchpad`), the Home page and the "Run setup again" button of Settings move to E8, with the
  confirmed defect of `lib/setup.ts:61` (the launchpad needs the GGUF reader, the bench runs, the estimate, the tuning
  hardware and the monitor).
- The 409 `A benchmark is running` of the four lifecycle routes, the pause of the external watch during a benchmark and
  the bench gate's use of the supervisor move to E7, with the bench runner; no stand-in until then.
- `profileId` of start and switch is a strict integer (`"1"` and `true` selected profile 1; a value that was no integer
  answered 404): now a 400 `RequestInvalid`. `since` of `/api/logs` is a non-negative integer in decimal digits (a
  negative value returned the whole ring, anything else counted as 0): now a 400.
- Every request to a llama-server is direct (`LlamaHttp`): the probes and `/props` no longer go through the proxy of
  the environment for a non-loopback host. The Hugging Face client keeps the proxy (E6).
- The 409s and 502s keep their messages and are told by their tag: `OperationInProgress`, `ServerAlreadyRunning`,
  `PortInUse` (with `port`, `by`, `pid`), `NoProfileToRestart`, `ServerNotReady`, `PropsUnavailable`, and
  `ProfileRunning` on the profile deletion.
- A lifecycle operation runs to its end whatever happens to the request that asked for it.

Found while porting E3, accepted with its result:

- A spawn failure is Node's own message (`spawn setpriv ENOENT`); the Nitro server's diagnosis of the `PATH` of the
  child's environment is dropped. A missing llama-server binary is a crash with code 127 (`setpriv` prints why).
- `GGML_CUDA_P2P` in llama-webui's own environment is read through `Config`, where an empty value reads as absent; in
  the `env` of the settings or of the profile any value counts, as before.
- A `log` message carries what was pushed since the last turn of the ring's publishing fiber (was: one microtask).
- `server-state` is published by the step that changes the state, under its lock: a step that leaves the state as it
  was publishes nothing, and a late answer (the health poll, the watch) never undoes a newer state.
- At an exit, the readers of llama-server's output are joined (1 s at most) before the exit line, so its last line is
  in the ring before `llama-server exited`.
- The stop at shutdown is the finalizer of the supervisor's layer: it waits for an operation in progress, and logs
  `stopping llama-server…` through Effect's logger (was a `console` line prefixed `[llama-webui]`).
- The external watch looks again 2 s after its previous look ended (`Schedule.spaced`), not on a 2 s clock.
- `/proc` is read through `FileSystem` (`llama/procScan.ts`), not by `findLlamaServerPid` of `llamacpp-js`.
- `LlamaHttp` has no null body (204, 205, 304, HEAD) and no `TypeError` on a `Request` or an odd body: a request is an
  `HttpClientRequest`.

Decided (the E4 plan):

- The NVML sampler is an Effect program over stdin and stdout (`collectors/nvml/worker.ts`, run through
  `effect/process`), not `fork` and IPC: NDJSON commands on its stdin, NDJSON messages on its stdout, both decoded
  with the schemas of `collectors/nvml/protocol.ts`; it exits when its stdin ends (was: the IPC disconnect), and the
  end of its scope kills it with SIGKILL at once. `effect/workers` was not chosen: its close waits 5 s for a worker
  stuck in the driver, and it needs `fork` in the server.
- The plan expected one new directive (`nodeBuiltinImport:off` on `node:ffi`): the rule does not flag `node:ffi`, and
  a directive that suppresses nothing fails `tsc`, so the tree has no new directive. The only change of
  `tsconfig.effect.json`: `monitor.ts` and `topology.ts` of the shared package joined the third override.
- The System page comes back without its Checks card (tuning checks E8, model list E6, bench E7): it moves to E8.
- The placement follows two subscriptions (`Supervisor.changes`, `LogRing.batches`): a `placement` message leaves just
  after the `server-state` message of the change that caused it (was: synchronously inside it), and two placements
  are compared with `Equal.equals` (was: their JSON).
- `PATCH /api/settings` answers `SettingsPatched` (the settings and an optional `warning`), the shape of the Nitro
  reply, and the web shows the warning again; the warning is logged with `Effect.logWarning` (was a line prefixed
  `[llama-webui]`).
- Every number the monitor sends is finite (`Schema.Finite`, `Schema.Int`): a reading that is not is sent as `null`
  where the field allows it, else as `0`, and an integral field takes the integral part (`monitor/finite.ts`). The
  Nitro server let `JSON.stringify` turn such a value into `null` even in a field typed `number`.
- Time is the `Clock`'s: the tick time, the freshness of NVML readings, the retry delays of perf and of the model
  disk; each delay is an option of its maker or layer.

Found while porting E4, accepted with its result:

- The monitor no longer holds the start of the app (the Nitro boot awaited it): the collectors are built by a fiber
  of its layer, then the ticks start. Until then `latest` is null and the history the empty dump of the configured
  shape; `configure`, `nvidiaSource` (now an effect) and `nvmlSystem` wait for them, so `GET /api/system/info` can
  wait up to NVML's 3 s `ready` after a start. Collectors that fail to start leave the monitor without snapshots:
  `nvidiaSource` `nvidia-smi`, `nvmlSystem` null, every settings change a 200 with the warning `the collectors could
  not start`.
- The parser of the placement is `monitor/placementLog.ts` (the plan said `placement.ts`, which `tsc` refuses next to
  `Placement.ts`: the names differ only by case). A buffer size that is not a finite number and a layer count that
  is not a safe integer are skipped; such an `offloaded` line no longer ends the main section.
- An unreadable `/proc/stat` gives `cpuPct` 0 and no core, an unreadable `/proc/diskstats` zero rates and no model
  disk (was null: the fields are numbers).
- A system collector switched off then on gets a fresh sampler: its first CPU reading is 0 again (the Nitro registry
  kept the instance).
- A `refreshApps` call while a compute-apps query runs waits for that same query, as the Nitro `appsInFlight` did,
  each caller at most the query's timeout plus 1 s; a query whose exit code is not 0 keeps the previous mapping (the
  Nitro reader parsed the output whatever the code).
- The nvidia-smi stream is started once the settings are applied (`start`), and a restart on a new interval drops the
  pending cycle (the Nitro reader kept it, which could mix two cycles); a cycle ends when a card's key is seen again.
- A line of the NVML sampler that is not a message, or its stdout ending, abandons it: logged as a warning, killed,
  its readings cleared (a line before `ready` gives the nvidia-smi fallback at once).
- `hiddenGpus` is applied by the tick to every reading, NVIDIA included (`monitor/gpus.ts`), as the Nitro
  `collectGpus` did: the nvidia-smi stream reads every card.
- A wait for the next tick is cut when the interval changes and counted again from the start of the last tick (the
  Nitro monitor re-armed its `setInterval`); the 30 s retry of the model disk is counted from the end of the lookup
  that missed (was its start).
- pci.ids: a later file of the list names a device an earlier one lacks, and an unknown device is remembered only once
  some file could be read (`hardware/PciIds.ts`, two `Cache`s); a PCIe link width that is not an integer is unknown.
- The Settings page gets its "Displayed GPUs" card back (its placeholder named E4), on `GET /api/system/info`.
- A reader that dies during a tick gives its own fallback (null, or no card), as the Nitro `.catch(() => null)` did;
  a defect of a collector during `configure` becomes `CollectorsNotApplied` (the readers report no error of their
  own), so the patch answers 200 with its warning.
