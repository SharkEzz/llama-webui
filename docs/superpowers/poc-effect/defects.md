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
| `lib/setup.ts:61`, `lib/bench/hardware.ts` | The raw `binary` setting goes to `buildOf`, which does not expand `~` either: `version` is null in the setup report for a `~/…` binary.                                                                  | confirmed | E3        |

## Reported, to verify with the milestone's plan

### E2: profiles and flags

- Deleting the profile the server is running answers 409 before the 404 of an unknown id is considered. `not a defect`:
  only a profile that exists can be running, so an unknown id never meets the 409 (returns with the supervisor, E3).
- The profile schema is strict and sets no maximum length on the name. `design choice`: the strict schema refuses a
  typo'd key, and a name has no limit to keep; ported as it is (`ProfileInput`).
- The cache of the flags of `--help` is never invalidated. `design choice`: the catalogue is read once per binary path
  per run (a failure is not kept); a rebuilt binary at the same path is read again after a restart (`Flags`).

### E3: supervisor, logs, setup

- `profileId` is coerced with `Number()`: a value of the wrong kind answers 404 instead of a validation error. `unverified`
- A failed launch still answers 202 and remembers the profile as the last started. `unverified`
- A refused start can set the state to `external` before its 409. `unverified`
- A start has no deadline. `unverified`
- `LLAMA_ARG_LOG_VERBOSITY` is only looked for in the environment of the profile and of the settings. `unverified`
- `server-state` is never sent to a client when it connects. `unverified`
- The supervisor calls the global `fetch`: the proxy of the environment applies to its requests to llama-server. `unverified`

### E4: monitor and collectors

- The `Monitor` class has no direct test. `unverified`
- `Ring.max()` and the `gpus: false` branch are never reached. `unverified`
- An NVML child that fails once it is ready is never started again. `unverified`
- `collectors.nvml` is only read at startup. `unverified`

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
kept, after the guard (was 404; at E1 the router of `effect/http` ignored the slash). The UI's paths keep theirs.

Decided (the E2 plan): requests are validated by their schema at the edge.

- On `PUT /api/profiles/:id` an invalid body is a 400 even when the profile does not exist (was 404 first).
- An id that is not a positive integer answers 404 `RouteNotFound` `Unknown route` (was `Profile not found`).
- A body that is not JSON answers `Invalid data: Expected a valid JSON body`, an empty one `Invalid data: Expected JSON
  value` (was `Invalid JSON`).
- An unknown key answers `unknown key` and comes first among the issues (zod worded it its own way, after the fields).
- The `code` of an error (`name-taken`) is its `_tag` (`ProfileNameTaken`).

Found while porting E2, accepted with its result:

- `POST /api/profiles/:id/duplicate` copies the stored profile as it is, without validating it again (was a 400
  `Invalid data: …` for a stored profile that no longer passes the schema).
- An item of an import that is not an object is explained as `Expected object` (was zod's own message).

Decided (user, 2026-11-14): the llama-tui import is not ported (llama-tui was never deployed beyond the user): its two
endpoints, the `llamaTuiImportDismissed` setting and the import banner are dropped. The generic import still reads a
`{ profiles }` file, and `duplicate` still turns a `llama-tui` source into `import`.
