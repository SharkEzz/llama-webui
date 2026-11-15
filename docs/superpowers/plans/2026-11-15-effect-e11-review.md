# Effect POC, E11: the decisions of the defects review

> The user reviewed `docs/superpowers/poc-effect/defects.md` after E10 and changed six of the choices that were ported
> as they were (2026-11-15). Everything lands on `poc/effect`; nothing on `master`.

## Calls (the user's)

1. **NVML restarts.** A sampler that dies after `ready` is started again, 3 times at most (pauses 1 s, 5 s, 30 s; the
   count starts over after 5 minutes of healthy sampling), then the source switches to nvidia-smi. A sampler that
   does not come up at startup goes to nvidia-smi at once, as before.
2. **Model paths.** An endpoint that takes a model or projector path in its request accepts a file under the models
   folder, or the model or projector of a profile; anything else is a 403 `ModelPathRefused`. Profiles themselves
   keep any path (they open the exception); a resume replays a stored spec; internal reads are not requests.
3. **Model deletion.** The checks first; then the profiles, then the files, in one SQL transaction (a file that cannot
   be removed rolls the profiles back); the `defaultProfileId` setting cleared after the commit.
4. **Bench events at shutdown.** The runner's shutdown step publishes the run and the sweep it saves `interrupted`,
   then no live, before the hub closes. A refusal before a run exists stays the answer of its request.
5. **404 for a missing file.** `BenchFileMissing` is a 404 (was 400), like `ModelNotFound` and `ProjectorNotFound`.
6. **The ROCm check.** One check per kept AMD card (`amd.rocm-gfx.<busId>`): the card's gfx target read from the KFD
   topology in sysfs, compared with the targets `libggml-hip.so` was built for.

## Tasks

### Task 1: 404 and bench events

- [x] `BenchFileMissing` 404; its tests, the docs.
- [x] The shutdown step publishes `bench-run`, `sweep`, `bench-progress: null`, `sweep-progress: null`; a test.

### Task 2: Model deletion

- [x] `deleteModel` in one transaction, profiles first; `defaultProfileId` after the commit; tests.

### Task 3: Model paths

- [x] The rule, its error, the endpoints; tests; contract cases.

### Task 4: ROCm check

- [x] KFD nodes and HIP targets in the system info; the check per card; tests.

### Task 5: NVML restarts

- [x] The sampler's death observable; the facade, the restarts, the switch to nvidia-smi; tests.

### Task 6: Docs and close

- [x] `defects.md`, `behaviours.md`, `report.md`, the site pages; golden updated and read.
- [x] `pnpm lint`, `pnpm check`, `pnpm test`, `site:build`, `check-links`; commit.
- [x] The ROCm check read on the user's rebuilt llama.cpp (when the user says it is ready).

## Closing

- `pnpm lint`, `pnpm check` (no `effect(` line), `pnpm test` (988 Vitest tests, 65 `node:test`), `pnpm site:build`
  and `check-links` (4450 links) green. The golden changed by `BenchFileMissing` 404 and four `ModelPathRefused` 403.
- Trial of the build on a copy of the user's data, the user's llama.cpp rebuilt with ROCm (its `libggml-hip.so` built
  for `gfx1201` only; `--list-devices` answers, so the `libblis.so.5` failure of E10 is gone):
  `amd.rocm-gfx.0000:08:00.0` `ok` (`gfx1201, in the build`), `amd.rocm-gfx.0000:0d:00.0` `na` (the iGPU is not
  kept); `GET /api/models/info` of a file outside the folder 403, a missing file inside it 404; the NVML sampler
  killed by hand is started again after 1 s, the source stays `nvml`.
