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

| Where                                      | Defect                                                                                                                                                                                                   | Status                                 | Ported at |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- | --------- |
| `lib/tuning/memo.ts:16`                    | `benchBinary(settings.get().binary)` gets the setting without `~` expanded: with a `~/…` binary the device listing of Tuning fails, and with it `POST /api/sweeps`. `GET /api/bench/devices` expands it. | fixed in E7 (the bench), E8 (the memo) | E7, E8    |
| `lib/setup.ts:61`, `lib/bench/hardware.ts` | The raw `binary` setting goes to `buildOf`, which does not expand `~` either: `version` is null in the setup report for a `~/…` binary.                                                                  | fixed in E8                            | E8        |

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

- The comment of `stopOrphans` says "interrupted", the code writes "stopped". `fixed in E5`: the doc comment of
  `ConversationsRepo.stopOrphans` says `stopped`, and the code still writes it (`chat/ConversationsRepo.test.ts`:
  stopOrphans marks every streaming message stopped and counts them; `chat/ChatRuns.test.ts`: orphans are marked
  stopped when the layer is built).
- `liveIds()` is never called. `confirmed`: not ported (`ChatRuns` has `live` and `isLive` of one conversation, the
  list asks `isLive` of each).
- Stopping an unknown id answers 409. `design choice`: a stop names a reply, not a conversation, and the answer is the
  same whether the conversation is missing or idle (`No reply in progress`); ported as it is (`chat/http.test.ts`: each
  endpoint of a conversation that does not exist is a 404, a stop of one a 409; contract `POST /api/chat/999/stop`).
- A send that registers between the wait of a delete (`stopAndWait`) and the delete itself starts a reply whose rows
  the cascade deletes: its writes find no message, its `done` is built in memory, and llama-server writes the reply for
  nobody. `not a defect`: the send is answered and nothing of the deleted conversation is left; the Nitro server had
  the same window (its delete awaited the run, then deleted). Ported as it is; no test makes it happen.

### E6: models and downloads

- `GET /api/models/info` reads any absolute path that ends in `.gguf`, outside the models folder too. `design choice`
  (the E6 plan's call, decided as E5 did): the site documents it as by design (no allowlist of folders,
  `site/content/developers/server/security.mdx`), the Tuning page (E8) reads the detail of a profile's model, which may
  be anywhere, and the API is behind the guard (loopback or the configured origin). Ported as it is
  (`models/http.test.ts`: info answers the detail of a model and of a file outside the models folder, its relPath
  absolute).
- Two 409 answers can only be reached in a race. `confirmed`, `fixed in E6`: `DELETE /api/downloads/:id` decides
  cancel-or-remove in one step under the queue's lock (`Downloads.remove`), so `This download is not running` (code
  `not-active`) and `Cancel this download first` (code `active`) are not ported (`downloads/http.test.ts`: delete of a
  running item cancels it and answers 204 at once; delete of a finished item removes it and keeps its files).
- Deleting a model deletes its files before its profiles. `design choice`: a file that cannot be removed answers 500
  and keeps every profile; the other order could leave profiles deleted for a model still on disk. Ported as it is
  (`models/http.test.ts`: a file that cannot be removed answers 500 and keeps the profiles).
- No test posts a valid download. `confirmed`, `fixed in E6`: `downloads/http.test.ts` (a valid download request
  stores the canonical repo id and the resolved sha and answers 202 with the items; a request naming a key the repo
  lacks is a 404 No GGUF; a key listed twice is a 400), on a fake Hub (`app/server/testing/hub.ts`).

### E7: bench and sweeps

- Resume stops and restarts llama-server before it answers 409 `Nothing to resume`. `confirmed`, `fixed in E7`: the
  check is `BenchRunner.startSweep`'s `check`, run under the claim before the gate (`bench/BenchRunner.test.ts`:
  resuming a sweep with nothing to resume is a 409 and stops nothing).
- In `runner.ts`, the `setLive` after the loop of a sweep is never reached: `restarting-server` is never broadcast
  during a sweep. `confirmed`, `fixed in E7`: the loop keeps the last item's live until the release, which publishes
  `bench-progress` with phase `restarting-server` and step null, then null (`bench/BenchRunner.test.ts`: the end of a
  sweep shows restarting-server while llama-server comes back).
- `POST /api/sweeps` answers 404 `Model not found` where run, resume and validate answer 400. Moved to E8 with the
  endpoint (`behaviours.md` E8, `From E7:`): E7 does not port the creation.
- Cancelling an unknown run id answers 409. `confirmed`, `fixed in E7`: an id with no row is the 404 `RunNotFound`
  `Run not found`, a row that is not the current run still the 409 `This run is not running`; a missing sweep is the
  404 `Sweep not found`, as before (`bench/BenchRunner.test.ts`: cancelling an unknown run is a 404, a run that is not
  current a 409).
- `DELETE /api/sweeps/:id` broadcasts even when it deleted nothing. `confirmed`, `fixed in E7`: the delete is one
  transaction that returns whether the row existed and the run ids it took; a sweep gone between the look-up and the
  delete is a 404 with nothing published (`bench/SweepsRepo.test.ts`: deleting a sweep that is gone returns none;
  `bench/http.test.ts`: a sweep's delete publishes its run ids, then the sweep, and a running one is a 409).
- `dispose()` broadcasts nothing. `design choice`: the hub closes every client with 1001 right after the runner's
  shutdown step, and a client that reconnects reads the rows (`interrupted`). Ported as it is.
- `GET /api/bench/runs` reads its query leniently (an unknown `kind` or `status` ignored, an unknown `sweep` read as
  the one-off runs, a bad `limit` as the default). `design choice` (the E7 plan's call): a strict query would turn
  into 400s requests the page never sends; the query schema is optional strings, read by `runFilters`.

### E8: tuning, topology, launchpad

- The default of the V cache type differs: the plan uses `ctv ?? ctk ?? f16`, the estimator `ctv ?? f16`. `confirmed`,
  `fixed in E8`: llama.cpp gives `-ctv` f16 unless told otherwise, so an item pinned `-ctk q8_0` was planned with a
  q8_0 V cache it does not get; the plan now measures with the estimator's `cacheOf` (`tuning/space.test.ts`: measures
  an item with the V cache llama.cpp gives it: f16 when only -ctk is set). The 324 plan items of the differential run
  that differ from Nitro's are all this fix.
- The PCIe and Resizable BAR checks ignore whether the card is kept. `design choice`: the link and the BAR say
  something about the machine whatever the profile uses. Ported as it is.
- `amd.rocm-gfx` is always `unknown`. `design choice`: rocminfo is not run. Ported as it is.
- A plan body without `spec` is never replayed by the contract suite. `confirmed`, `fixed in E8`: the body is decoded
  at the edge, a missing `spec` is the 400 `RequestInvalid` on the path `spec`, and the contract sends `{"spec":{}}`;
  `tuning/http.test.ts` sends a body without it (a plan without its spec is a 400 on the path spec; with one, its
  items).
- `POST /api/sweeps` answers 404 `Model not found` where run, resume and validate answer 400 (moved from E7).
  `design choice` (Call 4 of the E8 plan): the creation loads the GGUF to plan, like `POST /api/tuning/plan`, and keeps
  its errors; run, resume and validate parse no GGUF and keep the 400 `BenchFileMissing`.
- The `git log` of the build date has no timeout. `confirmed`, `fixed in E8`: bounded to 5 s like every program of the
  server, a timeout gives no build date (read, not tested: no test drives a slow git).

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
- A launch of a perf or nvidia-smi stream and the write of the state that names it are one uninterruptible step: no
  stream runs that the state does not name, and the reader of a stream that was replaced changes nothing.

Found by the final review of E4, fixed with it:

- A killed program's exit is awaited 1 s at most (`closeWithin` of `app/server/process/followed.ts`, through
  `followProgram` for every long-lived program and the compute-apps query): the spawner's release waits for the exit
  without a limit, and a program in uninterruptible sleep in a driver call does not exit on SIGKILL until the call
  returns. Past the bound the close is logged and goes on alone. At the start, an NVML sampler that does not come up
  falls back to nvidia-smi after its 3 s and that second at most; at the end, the collectors' scope closes in 1 s at
  most, their programs together, before the supervisor stops llama-server (the Nitro `terminate()` + `unref()` did
  not wait at all). A compute-apps query stuck that way stays in flight until it is gone: stuck queries do not pile
  up.
- `configure`, `nvidiaSource` and `nvmlSystem` of the monitor wait 10 s at most for the collectors: a patch is a 200
  with the warning `the collectors are not up yet` instead of a request that hangs, and the change is applied once
  they are up.
- The monitor's `configure` applies the stored settings, read under its lock (it was handed the patched settings: two
  patches saved at once could configure in the other order and leave the monitor on the older ones), and the handler
  calls it only when the patch changed what the monitor follows (`collectors`, `pollIntervalMs`, `historySeconds`,
  `hiddenGpus`): with collectors that could not start, a theme or a binary saved no longer shows the warning.

Decided (the E5 plan):

- The three streaming endpoints (`messages`, `regenerate`, `stream`) are `HttpApi` endpoints whose success is an
  `HttpApiSchema.StreamSse` of `ChatSseEvent` (one server-sent event per `ChatEvent`: `event:` its type, `data:` its
  JSON); the typed client decodes a reply into a `Stream` of `ChatEvent`. Their handlers answer `sseResponse` of
  `app/server/http/Sse.ts`, which keeps the headers of the Nitro stream and its `: ping` every 15 s. The plan named
  `handleRaw`: they use `handle` (see below).
- `GET /api/chat/:id/stream` answers 204 when no reply runs: its success is the `StreamSse` or
  `HttpApiSchema.NoContent`, read as `undefined` by the client.
- The errors are tagged, with the Nitro messages word for word: `ConversationNotFound` (404 `Conversation not found`),
  `ReplyInProgress` (409 `A reply is already in progress in this conversation`), `NoReplyInProgress` (409 `No reply in
  progress`), `NothingToRegenerate` (409 `Nothing to regenerate`), `EmptyMessage` (400 `Empty message`), and E3's
  `ServerNotReady` (409 `llama-server is not ready`) and E2's `ProfileNotFound` (404).
- The requests are strict: `POST /api/chat` takes `{ profileId?: Int | null }`, `POST /api/chat/:id/messages`
  `{ content: String }`, `PATCH /api/chat/:id` the `ConversationPatch` schema with the limits and messages of the zod
  schema; any other key or type is a 400 `RequestInvalid` (was `profileId: expected an integer or null`, `content:
  expected a string`, `Invalid JSON`, `JSON object expected`).
- Two sends at once to one conversation give one reply and one 409: the check that no reply runs, the look for a
  server, the storing of the messages and the registration of the run are one uninterruptible step under the lock of
  the runs (the Nitro server got this from JavaScript's single thread).
- A stop of a conversation that does not exist answers 409 `No reply in progress`, as before; `liveIds()` is not
  ported; the comment of `stopOrphans` says `stopped` (above).
- llama-server's `timings` are decoded with `LlamaTimingsSchema` (all `Finite`) before they become `MessageStats`:
  timings that do not decode are dropped alone (the chunk keeps its delta), and the reply then has no stats, instead of
  a NaN that would stop its `done` from encoding.
- Time is the `Clock`'s: the 1000 ms throttle of the partial writes (tested on the `TestClock`), the time to first
  token and the duration.
- The chat does not use the I/O of `llamacpp-js`: the request goes through `LlamaHttp` (`llama/chatStream.ts`), the
  SSE body is parsed by `Sse.decode` of `effect/encoding`, and the failures are tagged (`LlamaHttpFailed`,
  `LlamaStreamFailed`, `LlamaStreamCut`, `LlamaUnreachable`) instead of thrown `Llama*Error`s.

Found while porting E5, accepted with its result:

- The streaming endpoints are served with `handle` returning `sseResponse`, not `handleRaw`: `handleRaw` never decodes
  the payload (`HttpApiBuilder.ts:968` of `repos/effect`), so the strict request rules would not apply to `messages`. A
  handler's declared error still answers with its status (both forms).
- A request that never reaches llama-server reads `llama-server unreachable: <the cause's message>` (`connect
  ECONNREFUSED 127.0.0.1:<port>`); the Nitro `llamaFetch` rejected with `fetch failed`, so the reply read
  `llama-server unreachable: fetch failed`.
- A strict-request refusal reads in Schema's wording: `Invalid data: Expected number | null (profileId)`, `Invalid
  data: Expected string (content)`, `Invalid data: Expected string (title)` (as the start's `Expected number
  (profileId)` since E3), `unknown key` for an unknown key; the sampling, title and system prompt messages of the
  PATCH are kept.
- `MessageStats` is all finite: a stored stats that no longer decodes (a `null` the Nitro server wrote for a NaN rate)
  reads as no stats, with a warning, the message kept; a run saves its stats only when every number is finite, else
  none; the `done` message built in memory (the conversation deleted) carries the stats a save would have written.
- The run leaves the runs before its `done` is published: a client that sends again as soon as it reads `done` gets no
  409.
- The shutdown step and `stopAndWait` read the runs under their lock (`SynchronizedRef.modify`), so a start in flight is
  stopped and saved too; the step saves every reply `stopped` first, then stops its run, so the run writes nothing after
  it.
- A new subscriber takes the replay and its subscription to the run's `PubSub` in one step: a listener is a stream, not
  a callback, so the Nitro "a listener that throws is dropped" has no counterpart.
- One lock serialises the starts of every conversation, not of one: a start is a few synchronous SQLite statements and
  the look for a server, so the cost is small, and the check and the registration stay one step.
- `ChatRuns.layerWith` needs the services of `chatTarget` (`Supervisor`, `ProfilesRepo`, `Path`) even when a test
  gives its own `target`.
- `ServicesTest` builds `ChatRuns.layer`: every test on it marks the `streaming` rows `stopped` when it is built and
  registers the replies' shutdown step.
- The contract has no successful reply and no `409 Nothing to regenerate`: a reply, and the regeneration check, which
  comes after the look for a server, need a ready llama-server, which the contract runner cannot wait for (the Nitro
  contract had a stream case run after the others, `runStreams`); `chat/http.test.ts` covers both over HTTP.
- The Chat page's `stem` (a pure function of `@/lib/models`, whose module does not compile until E6's store) moved
  unchanged to `app/src/lib/stem.ts`. The web's `callStream` (`app/src/lib/api.ts`) tells a body that breaks off
  (`ApiUnreachable`, the store reads the conversation again) from an event that does not decode (`ApiReplyInvalid`,
  logged, a toast). The store is built by `makeChatStore` on the calls it is given, so `app/src/lib/chat.test.ts`
  drives it on a fake `fetch` (a follow answered 204, a reply without `done`, a body that breaks off, a 409, a reply
  aborted when another conversation opens).
- The developer pages of the site still describe the Nitro client (`readSse()`, `apiError()` in
  `site/content/developers/frontend.mdx`): they are rewritten at E10 (design spec, the E10 row and its sync rule).

Found by the final review of E5, fixed with it:

- A run that dies (a defect in its fiber, such as a database write that dies) is saved `error` with its text so far
  and the error `llama-webui: internal error`, then its `done` is published: its row was left `streaming` until the
  next start and its streams never ended. The save is best-effort (`Effect.ignoreCause`, logged), so a save that dies
  too still ends the streams (`chat/ChatRuns.test.ts`: a reply whose run dies is saved error with its text so far, and
  its stream ends with done).
- The shutdown step closes the runs under their lock, in the step that takes them: a send or a regeneration accepted
  after the step started a reply that no step saved `stopped` (the end of the layer interrupted it, its row left
  `streaming`); it is now a 409 `ServerNotReady` that stores nothing (`chat/ChatRuns.test.ts`: a send after the
  shutdown step is ServerNotReady and stores nothing).
- A reply is traced under its own root span `ChatRuns.reply` (attribute `conversationId`): forked into the layer's
  scope, it was a child of the span of the request that started it, which ends long before the reply.

Decided (the E6 plan):

- Hugging Face has its own HTTP service, `HfHttp` (`app/server/hf/HfHttp.ts`): `NodeHttpClient.layerNodeHttpOptions`
  with `keepAlive` under its own tag, `node:http`/`node:https` in HTTP/1.1 (the HTTP/2 window of Hugging Face capped a
  stream at ~22 MiB/s), each request in its caller's scope, no time limit of its own (an API call waits 10 s, a
  transfer 60 s of silence) and no redirect followed. `downloadFetch` is not ported.
- The proxy of the environment is the agents' (`proxyEnv` of `HfHttp`'s two agents, read through `Config`, with
  `localhost`, `127.0.0.1` and `::1` always kept direct), not a global one: `useEnvProxy` (`setGlobalProxyFromEnv`) is
  not ported, nothing else of the Effect server uses `fetch` or Node's global agents, and "set first, undone last at
  boot" becomes "the agents are made and destroyed with `HfHttp`'s layer". `LlamaHttp` keeps its direct agent.
- `LLAMA_WEBUI_TEST_OFFLINE=1` (exact value) is read by `HfHttp.layer`: every request fails as a `TransportError`
  `fetch failed`, so the Hub endpoints answer 502 `Hugging Face unreachable: fetch failed`, as before.
- The Hub's unreachable message is `Hugging Face unreachable: <reason>`, the reason the `TransportError`'s description,
  else its cause's message (`connect ECONNREFUSED …`, `getaddrinfo ENOTFOUND …`), else its code: Node's `fetch` said
  `fetch failed` for all of them. A Hub API call without an answer in 10 s reads `Hugging Face unreachable: no answer
  in 10 s` (was `The operation was aborted due to timeout`).
- A stamp is `<mtime ms>:<size>` per part from `FileSystem`'s `mtime`, whole milliseconds: the Nitro server wrote
  `mtimeMs` with its fraction, so each `model_cache` row it wrote misses once and is read and rewritten at the first
  scan.
- The 8 parsed GGUFs are a `Cache.makeWith` of capacity 8 (a failed read kept for no time): Effect's `Cache` is LRU, a
  hit refreshes the entry, where the Nitro map dropped the oldest read.
- The query refusals are a 400 `RequestInvalid` `Invalid data: <message> (<key>)`, as E2 to E5 set for bodies:
  `GET /api/hf/search` `q`, `GET /api/hf/repo` `id`, `GET /api/models/usage` `path`, `GET /api/models/info` `path` (was
  a 400 with the bare message).
- An id of `/api/downloads/:id` that is not a positive integer is the 404 `RouteNotFound` `Unknown route` (`IdParam`,
  as E2; was `Download not found`).
- The errors are tagged, with the Nitro messages word for word: `ModelNotFound`, `ModelFileNotFound`,
  `ModelUnreadable`, `ModelInUse`, `HfGated`, `HfNotFound`, `HfUnauthorized`, `HfRateLimited`, `HfUnreachable`,
  `HfInvalidPath`, `ListedTwice`, `AlreadyQueued`, `DiskFull`, `DownloadNotFound`, `NotFinished` (the Nitro `code` of
  an answer becomes its tag; the web tells `HfGated` and `HfNotFound` by it). The `code` stored in a `DownloadItem`
  stays the Nitro string (`hf-gated`, `checksum-mismatch`, `disk-full`, `download-failed`, `hf-unreachable`…).
- The retries are a loop over the pauses 2, 4, 8, 16 and 30 s (`Effect.sleep` on the `Clock`), not a `Schedule`: the
  budget is reset after an attempt that received data, which a `Schedule`'s state cannot see without the attempt's
  outcome.
- The stall is `Stream.timeoutOrElse` of 60 s on the body plus a 60 s wait for the headers (was a `setTimeout` reset on
  each chunk); both retry as `no data for 60 s`.
- The download queue is a scoped service, `Downloads`: one fiber in the layer's scope, its state in one
  `SynchronizedRef`, `enqueue` and `retry` serialised by a semaphore and their rows written in one uninterruptible
  step, a shutdown step that stops the transfer and writes nothing (the item stays `downloading`, its `.part` kept).
- The sha256 (`createHash` of `node:crypto`, `downloads/hash.ts`) and the free space (`statfs` of `node:fs/promises`,
  `downloads/freeSpace.ts`) are two new `nodeBuiltinImport:off` directives: Effect's `Digest` is one-shot over a
  `Uint8Array` (a GiB file cannot be held), `FileSystem` has no `statfs`.
- The model deletion's check of a benchmark in progress and of a running sweep (`A benchmark in progress uses it`, and
  `blocked` in the usage) is removed until E7, which brings it back with the bench (a `From E6:` line of E7 in
  `behaviours.md`): `blocked` reads the managed server and the queue's active items only.
- `app/server-legacy/lib/llamaFetch.ts` is kept whole: `downloadFetch` and `llamaFetch` share `nodeFetch`, legacy files
  are only deleted, never edited, and the E7 bench reads `llamaFetch`; the file goes with E7.

Found while porting E6, accepted with its result:

- The `HttpApi` groups (`ModelsApi`, `HfApi`, `DownloadsApi`) joined `Api.ts` with their handlers (Tasks 4, 5 and 8),
  not with the schemas (Task 1): a group in `Api` without its handlers does not build the server.
- `vramFit` and `profileModelPath` of `@llama-webui/shared` are `dual`s.
- New messages for the requests: `At least one variant expected` and `16 variants at most` (the keys of a download),
  `Variant key expected` and `1024 characters at most` (one key); a missing `id` reads `Invalid repository id: `, a
  missing `q` or info `path` the same message as an invalid value; a query key given twice is a 400.
- A blank `HF_TOKEN` falls back to `HUGGING_FACE_HUB_TOKEN`, a blank `no_proxy` to `NO_PROXY` (an empty variable is
  unset). An https request through a proxy (CONNECT) is not tested, and the unreachable tests rely on `*.invalid` not
  resolving, as the Nitro ones did.
- The fallback message of a `stat` that fails with no errno is the error's message, not an errno; the branch of a
  file behind a folder the user cannot enter is not tested as root (`skipIf`).
- `HfVariant` has no `queued` flag: the plan named one, the Nitro type never had it.
- A Hub API call follows the redirects that stay on the endpoint's origin, 5 at most, with the token (a renamed
  repository answers 307 to its new name); a redirect elsewhere is refused and the token never leaves the origin (the
  Nitro `fetch` followed any redirect). A caller that leaves does not end the whoami that other callers wait on.
- A download follows 6 redirects and fails on the 7th (`Too many redirects from Hugging Face`), as the plan says: the
  Nitro loop failed after the 5th. A connection cut mid-file reads `Hugging Face unreachable: <reason>`. The Nitro
  `empty response` failure could not be reached and is dropped: an empty body reads `<path>: got 0 of <size> bytes`,
  retried as a short body.
- A request for one variant listed twice in one enqueue (the schema does not refuse it) is an `AlreadyQueued` 409;
  the HTTP payload refuses the same key twice first, as a 400 `ListedTwice`.
- `Downloads.layer` sits in the tier of `ChatRuns` (`App.ts`); its shutdown step runs before the hub's flush, and the
  tiers are then undone from the top. The lifecycle test of a SIGTERM during a download relies on the real `statfs`
  with the 1 GiB margin.
- The contract cases of the models, the Hub and the downloads were reconciled with the existing ones; the unknown
  download is id `999`.
- The web: a reply only adds the items the list does not have yet (`addMissing`), and the server publishes an item
  before it answers, so a reply that arrives after the queue moved on does not undo a `/ws` message (found by the look
  of Task 9). `main.tsx` starts the downloads' sync again, as before E1. Rolldown's `INEFFECTIVE_DYNAMIC_IMPORT`
  warning (`src/app/router.tsx` imported lazily by `downloads.ts`, statically by `main.tsx`, as in the Nitro web),
  inherited, is gone with the final review's fixes (below).

Decided (controller, the final review of E6):

- An enqueue accepted while the server is closing writes and publishes its rows; they are not started (the queue no
  longer starts its loop once closing) and the next start resumes them. Cost if wrong: a user who queues in the last
  second of a shutdown sees the download start only at the next launch.
- A cancel that lands just as a transfer completes discards the finished files: the cancel wins, as in the Nitro
  queue (the loop reads the cancel before it saves the outcome). Cost if wrong: a file that was complete is downloaded
  again.

Found by the final review of E6, fixed with it:

- A body longer than the file counted as progress: the `.part` was deleted and the retry budget started over, so a
  server that always oversends downloaded again forever. An oversize no longer counts as progress, and the item fails
  once the retries are spent (`downloads/transfer.test.ts`: a body longer than the file does not reset the retry
  budget: a server that always oversends fails the item).
- The Hub's commit `sha` (`RepoInfo`) was any string, and the queue pins the download to it (a path segment of the
  resolve URL): it must be 40 lowercase hex digits (`HF_COMMIT_RE` of `@llama-webui/shared`, also the rule of the
  request's `revision`), else the answer is an invalid response (`hf/HfClient.test.ts`: a commit sha that is not 40
  hex is an invalid response).
- A whoami that died left its `Deferred` completed with no account and the entry kept, so the token's status read
  unchecked until the next restart. Any end but a success now forgets the entry (`hf/HfClient.test.ts`: a whoami that
  dies is not cached: the next status asks again).
- The web's `load()` replaced the list and the live progress whole: a `/ws` message that arrived while the list was
  read was undone; and an enqueue (or retry) reply that arrived after the item's `download-deleted` brought it back.
  The store now records what the messages change while a request is in flight and keeps it over the reply
  (`app/src/lib/downloads.test.ts`: a message that arrives while the queue is read is kept: the list read before it
  does not undo it; an enqueue or retry reply that comes after its item was cleared does not bring it back).
- The removal of the folders left empty (a model deleted, a download canceled) checked that a folder was empty, then
  removed it recursively: a file a download wrote in between went with it. It is now `rmdir` of `node:fs/promises` (a
  `nodeBuiltinImport:off` directive), which the system refuses for a folder that is not empty.
- `enqueue` writes its rows in one transaction (`DownloadsRepo.createAll`: every row or none,
  `downloads/DownloadsRepo.test.ts`); a cancel whose deletion fails is logged (a warning naming the item's folder,
  with the cause) instead of ignored.
- The web's downloads store no longer imports the router lazily (the `INEFFECTIVE_DYNAMIC_IMPORT` warning of the
  build): `startDownloadsSync({ navigate })` takes the router's navigation from `main.tsx`, which a finished
  download's Details uses.

Decided (the E7 plan):

- `POST /api/sweeps` (the creation of a sweep) moves to E8 with its page (the user's decision, 2026-11-15): it needs
  `planSweep`, the estimator and the tuning hardware. E7 ports the engine: `BenchRunner.startSweep({ files,
  stopServer, check?, prepare })` is the one entry of a sweep run (resume, validate, and E8's create).
- Cancelling an id with no row is the 404 `RunNotFound` (was 409); a row that is not the current run stays the 409.
- `POST /api/sweeps/:id/resume` checks that there is something to resume before the gate: `Nothing to resume` no
  longer stops and restarts llama-server.
- The end of a sweep publishes `bench-progress` `restarting-server` (step null) while llama-server comes back, then
  null; between items the live goes back to null only when another item follows.
- `GET /api/bench/runs` stays lenient (optional strings, `runFilters`); `DELETE /api/bench/runs` takes `failed` as the
  literal `'1'`: any other or missing value is the 400 `RequestInvalid` `Invalid data: ?failed=1 expected (failed)`
  (was the bare message), as E6's queries.
- Every `:id` is an `IdParam`: a bad id is the 404 `RouteNotFound` `Unknown route` (was `Run not found`, `Sweep not
  found` or `Profile not found`). The payload is decoded before the handler: a bad body on an unknown or running sweep
  (resume, validate) is a 400 where it was the 404 or 409 of the look-up.
- `POST /api/bench/run` is strict `{ spec, stopServer? }`: its issue paths carry the `spec.` prefix, and a missing
  `spec` reads `Invalid data: Missing key (spec)`. The resume body stays schema-less (a record; only `stopServer ===
  true` counts); validate is strict `{ n: 1–5, default 3, stopServer? }`.
- The errors are tagged (`BenchRunning`, `BenchFileMissing`, `ServerStopTooSlow`, `ExternalServerRunning`,
  `ServerRunning`, `RunNotFound`, `RunNotRunning`, `RunStillRunning`, `SweepNotFound`, `SweepNotRunning`,
  `SweepStillRunning`, `NothingToResume`, `NothingToValidate`), the messages word for word; the web tells
  `ServerRunning` by its `_tag` (was the code `server-running`).
- The claim of the runner is one `SynchronizedRef.modify`, released by `ensuring`; a client that leaves between its
  claim and its fork leaves no claim, and the gate it took is released (llama-server back). The run or the loop is
  forked in the layer's scope. `busy` = a claim, a current run, a running sweep, or the gate held.
- The gate is a module of the runner (`makeGate`), on `Supervisor`: it forks the stop in the runner's scope
  (`Supervisor.stop` waits for the stop, where the legacy gate started it without awaiting) and `ready` joins it.
- The bench's processes are followed programs under `setpriv --pdeathsig KILL --`; a cancel sends SIGTERM, waits
  `killTimeout` (5 s in the app, 1 s in the tests), then pushes `[llama-webui] not stopped after <ms> ms, SIGKILL` and
  sends SIGKILL. The trial talks to its llama-server through `LlamaHttp`: `llamaFetch` is not ported.
- The runner's shutdown is a `Shutdown.before` step: it sets `closing`, interrupts the run and the loop (the child
  SIGKILLed through its scope), writes the run and its sweep `interrupted`, publishes nothing and does not release the
  gate. The orphans of the last run are marked when the runner's layer is built, before any request is served.
- Every bench binary (`--list-devices`, `--version`, the run) is the `binary` setting after `expandHome` (the bench
  half of the `~` defect).

Found while porting E7, accepted with its result:

- The plan's Architecture says "sweeps (5 endpoints)"; its table lists six (list, get, remove, cancel, resume,
  validate): 8 + 6 = 14 endpoints.
- `BenchApi` and `SweepsApi` joined `Api` at Task 8 with their handlers, not at Task 1: a group without handlers does
  not build the server (the E6 precedent). The test of the fourteen endpoints used a local `HttpApi` until then.
- The schemas left zod: strict through the `STRICT` parse options and `messageUnexpectedKey: 'unknown key'` on each
  strict struct. The stored twins (`StoredBenchParams`, `StoredBenchSpec`, `StoredSweepSpace`, `StoredSweepSpec`)
  have no checks and no defaults; `ngl` keeps its one union message (`a number, “all” or “auto”`) for any miss, an out
  of range number included. The measured numbers are `Finite`, the ids, times and counts `Int`.
- Signatures changed by the `missingPipeableSignature` diagnostic: `withCtx`, `expandSpace`, `itemLabel` are `dual`
  (data-first calls unchanged); `scoreOf(run, { preset, ctx })` and `rankRuns(runs, { preset, ctx })` take an options
  object (was positional), `estimatedSweepSeconds({ items, fileBytes, r })`. The E8 page's `RankingTable.tsx` follows.
  `benchFailure({ lines, exit, tool? })`, `measure({ values, tokens })`, `draftAcceptPct({ drafted, accepted })` take
  an object; `parseSmiLine` returns an `Option`.
- `endingOf` and `causeMessage` moved from `Supervisor.ts` to `app/server/process/ending.ts`, shared with the bench.
- `which` checks the execute bits of a stat (`FileSystem` has no `X_OK`) and reads `PATH` through `Config`.
- A timed-out device listing says `llama-bench --list-devices timed out after 15s` (was `killed by SIGKILL`). The
  `--version` build is cached per binary file and modification time, for any outcome.
- `RunFilters` holds `Option`s; `requeueInterrupted` is one statement (was a select and one update per row); counts
  come from `RETURNING id`. A `stats_json` that does not decode reads as no results with a warning; a spec, hardware or
  VRAM that does not decode is a defect.
- `makeGate` takes `Supervisor`, `LogRing` and `Scope` from the context (the Task 4 interface; the plan's Calls wrote
  `{ supervisor, ring }`). An idle or crashed server: the gate is taken and nothing is recorded to restart. A second
  concurrent release awaits the first.
- `execute` takes the run, its start time, a cancel `Deferred` and the monitor's GPUs and disk; its `onLive` says when
  only the log lines changed, so the runner throttles those only (phase and step changes go out at once, as the
  legacy executor). The throttle is leading-edge: a dropped line change is not resent (as before).
- The gate says whether its stop still runs (`stopping`), so a run shows `stopping-server` meanwhile (not tested: the
  fake stops in a few ms).
- An interruption of the trial (llama-webui stopping) kills its llama-server at once through its scope, not SIGTERM
  then the timeout. The trial's own SIGKILL line carries the `[llama-webui]` prefix (the legacy trial had none).
- The shutdown step keeps an error the run already had (a cancel then a stop) instead of always writing `interrupted
  (llama-webui stopped)`.
- `validate` computes its best runs, and `NothingToValidate`, before the claim; the answers are the same.
- `toProfile` writes `cwd` only when it is not empty (the same result: `profileModelPath` always gives one).
- The web's Bench store decodes the form's spec with the schema before it sends it (the typed client encodes the
  payload, so a loose spec would throw in the client): a refusal goes on its fields and nothing is sent. Its store is
  `makeBenchStore({ call })`, the client injected.
- The page look of Task 9 used the `puppeteer-core` of `site/` with the system Chromium: Playwright is not installed.

Found by the final review of E7, fixed with it:

- `start` and `startSweep` set `abandon` (the gate's release on a start that does not go through) only after
  `gate.acquire` returned: an interruption landing between the two left the gate held, so the runner busy until the
  app restarts. `abandon` now covers the acquire (its own refusals leave the gate free, and a release of a free gate
  does nothing). Read, not tested: the window is between two steps of one fiber.
- `abandon` restarted llama-server even while the app stopped: a request interrupted by the shutdown (its HTTP fiber
  ends after the shutdown steps) restarted the server it had stopped. It now does nothing once the runner is
  `closing`. Test `a request interrupted by the shutdown restarts nothing` (fails without the guard).
- Three tests read the machine they ran on, and failed on this one (they predate E7):
  - `resolveModelDisk resolves a partition to its disk` wrote its model under `/tmp`, a tmpfs whose device major is 0,
    which names no disk. Its model now goes under the repository's `.cache/` (a block device).
  - The `hf/http.test.ts` configuration set `HF_TOKEN` and `HUGGING_FACE_HUB_TOKEN` to `''` over the environment
    (`ConfigProvider.layerAdd`, `asPrimary`): an empty value counts as unset, so a token in the shell's environment was
    read. They are now `' '` (blank, trimmed to no token).
  - `Monitor.test.ts` listed the host's AMD cards. `Collectors.layerWith` takes a `drmRoot` (default
    `/sys/class/drm`), which the test points at a missing folder.

Decided (the E8 plan):

- The estimator is rewritten, not copied (the diagnostics refuse native array methods and implicit booleans). A
  differential run, kept out of the tree, ran the legacy `lib/tuning/` (copied with `git show` into the session's
  scratchpad, never imported) and the new modules on the same inputs: the fixtures of the legacy tests, a generated
  grid (every preset, 0 to 3 cards across CUDA, Vulkan and ROCm, MoE and dense models, pinned `dev`, `ngl`, `ncmoe`,
  `fa`, `ctk`, `ub` and `ctx`) and the GGUF headers of the models on this machine. 114,072 inputs, 113,748 equal; the
  324 others are plan items with `-ctk q8_0`, all the V cache fix (the plan item's V cache, above). Against the legacy
  patched to `ctv ?? f16`, every plan item is equal.
- The memos are a service, `TuningMemo` (two `Ref`s of `HashMap`s keyed by model path); the CPU info is
  `Effect.cached` inside `TuningHardware`; the `--list-devices` and `--version` caches stay `BenchHardware`'s. A route
  reload no longer exists, so "the memos survive a route save" is moot.
- The tuning hardware and the setup report read the `~`-expanded binary (the two `~` defects of the table, fixed).
- New error tags: `ModelPathInvalid` 400 `Expected an absolute path to a .gguf file`, `ProjectorNotFound` 404
  `Projector not found`, `FileTooSmall` 400 `File too small to measure (<n> MiB)`, `NothingToRun` 409 `No configuration
  to run: <n> excluded by the estimator`; `ModelNotFound`, `ModelUnreadable` and `ModelFileNotFound` come from E6, and
  the disk measure's `BenchRunning` keeps its own message (`A benchmark is running: the measurement would be skewed`).
- `POST /api/sweeps` runs on `BenchRunner.startSweep`: the exclusions are its `check`, under the claim, so a busy runner
  answers its 409 `A benchmark is running` before `No configuration to run`; `prepare` stores the sweep and its items in
  one transaction. Its body and the plan's are decoded at the edge: an issue's path starts with `spec.`.
- `git log` (the build date of the checks) is bounded to 5 s.
- The legacy tests of `fileRange` become the tests of the disk measure's range read.

Found while porting E8, accepted with its result:

- The disk measure belongs to its request: a client that leaves interrupts it (the platform interrupts the handler's
  fiber), its file closed by its scope and nothing memoized (was: it went on to the end).
- The estimate cannot fail any more (a pure function on a hardware read without error): the launchpad's `fit` is null
  only when llama-bench lists no device while the monitor sees GPUs. The legacy test `launchpad: a failing estimate
  drops the fit badge only`, which injected a throwing estimate, maps to that case in the inventory.
- A plan or sweep spec with a relative or non-`.gguf` `modelPath` is refused by the schema (400 `RequestInvalid`), as
  Nitro's `SweepSpecSchema` did; only estimate and disk speed, whose `modelPath` is any non-empty string, answer the 400
  `ModelPathInvalid` of `loadModel`.
- Only a `no` verdict excludes a sweep item: a RAM overflow is `tight` (mmap reads the rest from disk), so an item that
  only overflows RAM is still run. The `NothingToRun` test pins `-dev CUDA0` on a machine without devices.
- The Checks card of the System page sits in the branch that has a monitor snapshot, as on `master`: with the stub
  monitor (no snapshot) the page shows its skeletons and no card. The look of the card was taken from the Tuning page.
- The web's tuning and setup stores call the typed client; they tell `ServerRunning`, `SweepNotFound` and
  `ProfileNameTaken` by their `_tag`, and their props and state take the schemas' `ReadonlyArray`s.
- The contract cases of the routes that read the machine (hardware, checks, estimate, plan, setup, launchpad) are
  `machine: true` (the golden records the names of their fields, not the body), as `GET /api/system/info`.

Found by the review pass of E8 (against its plan and `behaviours.md` § E8):

- Every task of the plan is done: the legacy files of the domain are deleted (`lib/tuning/`, `lib/setup.ts`,
  `lib/bench/hardware.ts`, the routes `tuning/*`, `setup.get.ts`, `launchpad.get.ts`, `sweeps/index.post.ts`, their
  tests); `/` and `/tuning` are in `PORTED`, `/setup` is its route, `MILESTONE_BY_PATH` is empty; the Checks card and
  "Run setup again" are back; the contract replays the 8 endpoints with their `violation` and `refusal` cases.
- The handlers keep the legacy order where it shows: the disk measure checks the runner before it reads the model; the
  creation loads the GGUF, then claims the runner, whose `check` refuses an empty plan.
- `behaviours.md` said `/setup` was in `PORTED`: it is `/tuning`. Fixed. No code change.

## Measures (`e<N>.json`)

The startup and shutdown medians of `scripts/poc/measure.ts` depend on the machine's load at the time: `e5.json`
reads a startup of 378 ms against 276 ms in `e4.json`, while the two builds measured back to back, interleaved, on
the same machine (`--skip-durations`) read 318 and 319 ms for E4 (`7b607b9`) and 321 and 314 ms for E5 (`aaf0c7a`),
shutdown 28/28 and 29/28. Startup and shutdown figures taken at different times are not comparable: to compare two
milestones, measure both builds back to back. The sizes and counts of the files do not drift.
