# Effect POC, E4: Monitoring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring the monitoring back under the Effect server: the collectors (NVML in a child process, nvidia-smi,
AMD sysfs, the llama-server process, CPU and memory, disks, perf DRAM bandwidth), the tick and its history, the
system information, the PCIe topology and the model placement; the `/api/monitor/*`, `/api/system/info` and
`/api/topology` endpoints, the `snapshot` and `placement` messages of `/ws`, the monitor's answer to a settings patch;
on the web the Dashboard, System and Topology pages.

**Architecture:** The shared package gets the monitoring and topology types as schemas, one API group (`monitor`) and
two `/ws` messages. The server gets three folders: `collectors/` (one reader per source, each an Effect on
`FileSystem` or a program run through `effect/process`, gathered by a `Collectors` service built from the settings),
`hardware/` (pci.ids names, the PCIe graph, the CPU) and `monitor/` (the history, a pure tick step, the `Monitor`
service and its loop, the `Placement` service, the handlers). The NVML sampler stays a child process, now an Effect
program spoken to in NDJSON over its stdin and stdout. The supervisor and the log ring get a subscription to their
changes, which the placement follows.

**Tech Stack:** Effect 4.1.4 (`effect`, `effect/process`, `effect/http-api`, `effect/encoding` `Ndjson`, `Stdio`),
`@effect/platform-node` (`NodeRuntime`, `NodeServices`), `node:ffi` in the sampler only, `@effect/vitest`, Rolldown,
Vitest 5, Biome.

**Spec:** `docs/superpowers/specs/2026-11-14-effect-server-design.md`. Acceptance list:
`docs/superpowers/poc-effect/behaviours.md`, section E4 (and its `From E3:` line). Rules of the new server:
`docs/superpowers/poc-effect/conventions.md` (read it before writing code).

**Calls made by this plan** (the author's; each is recorded by Task 13):

- **The NVML sampler is an Effect program over stdin and stdout, not `fork` and IPC.** It runs through
  `effect/process` like every other program (`node --disable-warning=ExperimentalWarning <worker>`), receives NDJSON
  commands on its stdin, answers NDJSON messages on its stdout, and exits when its stdin ends (the server gone, even
  killed: what `disconnect` did). Both sides decode the messages with one `Schema` (`collectors/nvml/protocol.ts`).
  The scope's end kills it with SIGKILL at once, as `terminate()` did. Effect's `effect/workers` (IPC child
  processes) was not chosen: its close waits 5 s for a worker stuck in the driver before killing it, longer than the
  whole 2 s shutdown, and it needs `fork` of `node:child_process` in the server.
- **One new directive:** `// @effect-diagnostics-next-line nodeBuiltinImport:off` on the `node:ffi` import of
  `collectors/nvml/symbols.ts` (Effect has no foreign function interface). Its reason on the line. No other directive
  and no override entry, except the shared modules of Task 1 joining the third override.
- **The System page comes back without its Checks card.** `ChecksCard` needs the tuning checks (E8), the model list
  (E6) and the bench (E7): it is removed until E8, recorded as a `From E4:` line in the E8 section.
- **The placement follows two subscriptions** (`Supervisor.changes`, `LogRing.batches`) instead of callbacks: a
  `placement` message now leaves just after the `server-state` message of the change that caused it, not
  synchronously inside it.
- **`PATCH /api/settings` answers `SettingsPatched`** (the settings and an optional `warning`), the schema of what
  the Nitro server answered; the web shows the warning again.
- **Every number the monitor sends is finite** (`Schema.Finite`, the `schemaNumber` rule): a reading that is not
  (NaN, Infinity) is sent as `null` where the field allows it, else as `0`. The Nitro server let `JSON.stringify`
  turn such a value into `null` even in a field typed `number`.
- **Time is the `Clock`'s** (`Clock.currentTimeMillis`): the tick time, the freshness of NVML readings, the retry
  delays of perf and of the model disk. Each delay is an option of its maker or layer, shortened in tests.

## Global Constraints

- Branch `poc/effect`, after E3 (`chore(poc): Measure E3`). No push, no pull request.
- **Before writing any Effect code, read `repos/effect/LLMS.md` completely**, then
  `docs/superpowers/poc-effect/conventions.md`, then the reference files of the task. `repos/effect` is the installed
  version (4.1.4): read it, not `node_modules`, and never edit it. Modules under `repos/effect/packages/effect/src/`
  (`process/`, `encoding/Ndjson.ts`, `Stdio.ts`, `Schedule.ts`, `Cache.ts`), the Node platform under
  `repos/effect/packages/platform/node/src/` and `platform/node-shared/src/`.
- **Effect diagnostics are blocking:** `pnpm check 2>&1 | grep -c 'effect('` prints `0`, warnings included. Fix what a
  rule reports with its own suggestion. The only changes of `tsconfig.effect.json`: `packages/webui-shared/src/monitor.ts`
  and `packages/webui-shared/src/topology.ts` join the third override (Task 1). The only new directive is the one on
  `node:ffi` (above). Any rule that seems wrong for a piece of code: stop and report, do not lower it.
- Idiomatic Effect only (conventions): services are `Context.Service` classes keyed
  `@llama-webui/app/server/<path>/<Name>` with their layers as statics, methods are `Effect.fn('Service.method')`,
  errors are `Schema.TaggedError` classes built with `X.make(…)`, time from `Clock`, configuration from `Config`,
  files from `FileSystem` and `Path`, programs from `effect/process`. Promise code wrapped in `Effect.promise` does
  not count as ported.
- **The monitor does not use the I/O of `llamacpp-js`** (`fetchLlama`: spec, "Outside world"): llama-server is read
  through `LlamaHttp`. Its pure functions may be imported: `probeUrl` (`llamacpp-js/client`), `parsePrometheus`,
  `parseSlots`, `liveRates`, `kvUsage`, `lastRequestStats`, `mergeRequestStats`, `requestDelta`, `foldRecent`,
  `specStats` and the types (`llamacpp-js/metrics`).
- `app/server-legacy/` is the Nitro server, a read-only reference: port its behaviour, not its structure; never import
  it. Only Task 13 deletes files in it. `site/` is not touched.
- A reply carries what the service holds: its schema has no input rule (conventions, "Replies").
- Server and shared code runs under Node as it is: relative imports end in `.ts`, erasable syntax only. This holds
  for the NVML worker too: `pnpm dev` runs it from source.
- No dependency is added. The server bundle and `nvml-worker.mjs` require nothing but Node builtins.
- **Never start anything on port 7860 or 7861.** Any run of the build or of `pnpm dev` carries a scratch data folder
  and a free port. Tests never use port 8080: every profile of a test sets its own free port.
- Tests that run a process, a socket or a schedule on real time:
  `layer(L, { excludeTestServices: true })('…', (it) => …)`. Pure functions and the tick step are plain tests. A test
  that starts a process asserts that it is dead at the end. Fake programs (`nvidia-smi`, `perf`, the NVML worker) are
  shell or Node scripts written in a scoped temporary folder.
- Code, comments, test names, messages and commits in English. Commits end with
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- `pnpm lint`, `pnpm check` and `pnpm test` green at the end of every task. Zero Biome warning; do not disable a Biome
  rule. Format a Markdown or JSON file you wrote with `pnpm exec biome check --write <file>`.
- Commands run from the repository root, with Node ≥ 26.13 first on the `PATH` (`node --version`).

## Facts verified on this tree

Found by reading `repos/effect` and the tree; rely on them.

- **A subscription to a `PubSub`:** `PubSub.subscribe(pubsub)` (needs a `Scope`) gives a `Subscription`;
  `Stream.fromSubscription(subscription)` streams it. Subscribing first and reading the current value after means no
  change between the two is missed.
- **A child's stdin is a sink:** `handle.stdin` is a `Sink.Sink<void, Uint8Array>`; feed it from a queue
  (`Stream.fromQueue(queue).pipe(Stream.encodeText, Stream.run(handle.stdin))`, forked in the child's scope).
  `ChildProcess.make(cmd, args, { stdin: 'pipe', stdout: 'pipe', stderr: 'inherit' })`.
- **NDJSON with a schema:** `Ndjson.decodeSchemaString(schema)` and `Ndjson.encodeSchemaString(schema)` of
  `effect/encoding` are channels for `Stream.pipeThroughChannel`; read their signatures in
  `repos/effect/packages/effect/src/encoding/Ndjson.ts`.
- **The worker's own I/O:** the `Stdio` service (`effect/Stdio`): `stdin` is a `Stream<Uint8Array>`, `stdout()` a
  sink of strings or bytes; `NodeServices.layer` (or `NodeStdio.layer`) provides it, and `NodeRuntime.runMain` runs
  the program. The stdin stream ends when the parent closes the pipe.
- **`node:ffi`** loads in Node 26.13 (`dlopen`, `DynamicLibrary`, `dlsym`…) and prints an `ExperimentalWarning`
  unless `--disable-warning=ExperimentalWarning`. This machine has no NVIDIA library: the real-NVML test skips.
- **`Effect.cached(effect)`** answers an effect that runs `effect` once and then replays its result.
- **Settings already hold** `pollIntervalMs` (250 to 60000, default 1000), `historySeconds` (30 to 1800, default 300),
  `hiddenGpus`, `collectors.{nvml,system,disk}` (`packages/webui-shared/src/settings.ts`).
- **`profilePaths({ profile, home, cwd, path })`** (`app/server/supervisor/command.ts`) gives the model path as
  llama-server opens it; `home` comes from `app/server/config/Home.ts`, `cwd` from `process.cwd()` as the supervisor
  reads it.
- **The hub encodes each message for each client** and drops one that does not encode, silently
  (`app/server/ws/WsHub.ts`): a snapshot with a non-finite number in a `Finite` field would never arrive.
- **The contract suite** has no `machine` recording yet (the Nitro suite recorded only the field names of a
  machine-dependent reply: `fieldsOf` of `app/server-legacy/lib/contract/cases.ts`), and `launch()` sets no
  `LLAMA_WEBUI_TEST_MONITOR`.
- **The web's monitoring stores** (`app/src/lib/monitor.ts`, `app/src/lib/topology.ts`) and `SystemPage.tsx` still call
  the deleted `api('GET …')`; `main.tsx` does not call `startMonitorSync()` nor `startTopologySync()`. The patch
  warning toast was removed at E1 (`git show 8f6fe35 -- app/src/lib/settings.ts`).

## Reference files

- Legacy behaviour (read, never import), under `app/server-legacy/lib/`: `monitor/{monitor,history,ring,placement}.ts`
  and `placement.test.ts`; `collectors/{registry,gpu,needs,proc,system,disk,amdgpu,nvidia,membw}.ts` and their tests;
  `collectors/nvml/{monitor,sampler,worker,read,symbols}.ts` and `monitor.test.ts`; `hardware/{pci,cpu}.ts` and
  `pci.test.ts`; `testing/stubMonitor.ts`; `boot.ts` (order of the stop), `deps.ts`; and
  `app/server-legacy/routes/api/{monitor/*,system/info.get.ts,topology.get.ts}`; `git show
  8f6fe35:app/server-legacy/routes/api/settings.patch.ts` and the `#35` test of `app/server-legacy/lib/routes.test.ts`.
- The model of each part: `app/server/supervisor/Supervisor.ts` (a long-lived process in its own scope, state in one
  `SynchronizedRef`), `app/server/supervisor/ExternalWatch.ts` (a scoped loop), `app/server/flags/Flags.ts` and its
  test (a program run and faked by a script), `app/server/llama/probes.ts` (a request through `LlamaHttp`),
  `app/server/llama/procScan.ts` (`/proc` through `FileSystem`), `app/server/logs/LogRing.ts`,
  `app/server/settings/http.ts`, `app/server/contract/cases.ts`.

## Review Focus

- **A reading that is not finite** (a counter that went backwards, a card that reports 0 bytes of VRAM, a rate over a
  zero interval) still gives a snapshot that every client receives and `/api/monitor/snapshot` serves. Test: Task 10,
  `a tick fed non-finite readings still encodes as a Snapshot`.
- **A machine with no GPU, no NVML library, no nvidia-smi and no perf** (this one) runs the monitor: snapshots
  arrive with `allGpus: []`, `nvidiaSource` is `nvidia-smi`, nothing is retried in a loop. Test: Task 9,
  `with no NVML library and no nvidia-smi, the collectors start and read no GPU`.
- **A llama-server that accepts and never answers** does not stall the monitor: each of `/health`, `/slots`,
  `/metrics` gives up after 800 ms and the next tick comes. Test: Task 10, `a llama-server that never answers gives
  health down within a second, and the next tick comes`.
- **Changing the poll interval or the history length with the Dashboard open:** the next snapshot carries the new
  `history` shape and the history keeps its newest points. Test: Task 10, `configure resizes the history keeping the
  newest points and moves the next tick to the new interval`.
- **Stopping the app with the Dashboard open and every collector program running** takes under 2 s and leaves no
  child behind. Test: Task 11, in `app/server/lifecycle.test.ts`, `SIGTERM with the monitor's programs running
  leaves none of them`.

---

### Task 1: Schemas, the monitor group and its messages

**Files:**

- Modify: `packages/webui-shared/src/monitor.ts`, `packages/webui-shared/src/topology.ts`,
  `packages/webui-shared/src/ws.ts`, `packages/webui-shared/src/api/SettingsApi.ts`,
  `packages/webui-shared/src/api/Api.ts`, `packages/webui-shared/src/index.ts`, `tsconfig.effect.json`
- Create: `packages/webui-shared/src/api/MonitorApi.ts`, `packages/webui-shared/src/monitor.test.ts`
- Test: `packages/webui-shared/src/topology.test.ts` (unchanged, must pass)

**Interfaces:**

- Produces (all in `@llama-webui/shared`, each a schema with its `type X = typeof X.Type`):
  - `monitor.ts`: `Health` (`Literals(['ok','loading','error','down'])`), `SlotView`, `RequestStats`, `SpecStats`,
    `RequestRecord` (the fields of the `llamacpp-js/metrics` interfaces of the same name), `GpuSample` (the detailed
    fields `Schema.optionalKey(Schema.NullOr(Schema.Finite))`, `suspended`/`hidden` `optionalKey(Boolean)`), `GpuReading`
    (`GpuSample` without `procVramBytes`), `MemInfo`, `MemBandwidth`, `SystemSample` (`load` a `NullOr` tuple of three,
    `memBw` `optionalKey(NullOr(MemBandwidth))`), `DiskRates`, `DiskSample`, `CpuInfo`, `Snapshot`, `HistoryDump`,
    `SystemInfo` (`{ cpu: CpuInfo, gpus: Array<{ key, name, vendor, busId, vramTotalBytes }>, nvidiaSource:
    Literals(['nvml','nvidia-smi']) }`), `NvidiaSource` (that literal union); `SERIES` unchanged. Every number is
    `Schema.Finite` or `Schema.Int`, none `Schema.Number`. The `llamacpp-js/metrics` re-export keeps only
    `slotContextTokens`.
  - `topology.ts`: `TopologyNodeKind`, `TopologyNode`, `TopologyLink`, `TopologyGraph`, `PlacementBuffer`, `P2pStatus`,
    `ModelPlacement`, `Phase`; `hostDevice`, `placementTotals`, `phaseOf`, `pcieBps`, `PHASE_LABEL` keep their
    signatures (parameters readonly) and pass the server's rules.
  - `api/MonitorApi.ts`: `MonitorApi`, group `monitor`, endpoints `history` (`GET /api/monitor/history`, success
    `HistoryReply` = `HistoryDump` fields and `bootId: String`), `snapshot` (`GET /api/monitor/snapshot`, success
    `NullOr(Snapshot)`), `systemInfo` (`GET /api/system/info`, success `SystemInfo`), `topology` (`GET /api/topology`,
    success `Topology` = `{ graph: TopologyGraph, placement: NullOr(ModelPlacement) }`). No error.
  - `api/SettingsApi.ts`: `SettingsPatched` = the fields of `Settings` and `warning: Schema.optionalKey(Schema.String)`,
    the success of `patch`.
  - `ws.ts`: `WsSnapshot` (`type: 'snapshot'`, payload `Snapshot`), `WsPlacement` (`type: 'placement'`, payload
    `NullOr(ModelPlacement)`), both in `WsMessage`.
  - `Api` adds `.add(MonitorApi)` after `ServerApi`.

- [ ] **Step 1: Write the failing tests** in `packages/webui-shared/src/monitor.test.ts`:
  - `the metrics schemas take what llamacpp-js produces`: `expectTypeOf<import('llamacpp-js/metrics').SlotView>()
    .toExtend<SlotView>()`, and the same for `RequestStats`, `SpecStats`, `RequestRecord`, `Health`.
  - `a snapshot round-trips through JSON`: a `Snapshot` literal with one GPU (detailed fields null and missing), one
    slot, `points: { 'llama.genTps': 12.5, 'sys.cpu': null }`, `system.load: [1, 0.5, 0.25]`, encoded with
    `Schema.encodeUnknownEffect(Schema.fromJsonString(Snapshot))` then decoded back equal.
  - `a snapshot with NaN does not encode`: `rates.genTps: Number.NaN` fails to encode (the reason the server keeps
    every number finite).
  - `WsMessage takes a snapshot and a null placement`: `{ type: 'placement', payload: null }` and
    `{ type: 'snapshot', payload: <the literal above> }` decode.
- [ ] **Step 2:** `pnpm exec vitest run packages/webui-shared/src/monitor.test.ts` fails (the schemas do not exist).
- [ ] **Step 3: Implement** the schemas, the group, the messages and the exports above. Before exporting a name from
      the barrel, check no other module exports it (conventions; `Health`, `NvidiaSource`, `Phase` and `Topology` are
      the likely clashes: `grep -n "export.*\b<Name>\b" packages/webui-shared/src/*.ts`). Add `monitor.ts` and
      `topology.ts` to the third override of `tsconfig.effect.json`.
- [ ] **Step 4:** `pnpm exec vitest run packages/webui-shared` passes, `topology.test.ts` unchanged. `pnpm check`:
      the web may now fail where it treated these types as mutable (`GpuSample[]` parameters, `.sort()` on a snapshot
      array): fix the web's parameter types to readonly, nothing else (its pages are not routed yet but are type
      checked by their tests). `pnpm lint`, `pnpm check`, `pnpm test` green.
- [ ] **Step 5: Commit** `feat(shared): Describe the monitoring and the topology with Schema`.

### Task 2: The history

**Files:**

- Create: `app/server/monitor/History.ts`, `app/server/monitor/History.test.ts`

**Interfaces:**

- Produces:
  - `historyPoints(historySeconds: number, intervalMs: number): number` = `ceil(historySeconds × 1000 / intervalMs)`.
  - `class Ring` (fixed capacity, numbers, NaN allowed): `push(v)`, `values(): ReadonlyArray<number>`,
    `last(): Option.Option<number>`, `length`, `static of(values, capacity)`. No `max()` (never used: defects.md).
  - `class History`: `constructor(capacity, intervalMs)`, `capacity`, `intervalMs`, `tick(at: number): void`,
    `series(key): Ring` (created empty on first use), `has(key)`, `keys()`, `resized(capacity, intervalMs): History`
    (the newest points kept), `dump(): Effect.Effect<HistoryDump>` (`at` is the last tick time, else
    `Clock.currentTimeMillis`).

The ring is the one mutable structure of the monitor, on purpose: one push per series per tick.

- [ ] **Step 1: Write the failing tests** (plain `it` of `@effect/vitest`; `it.effect` for `dump` on the `TestClock`):
  - `historyPoints: 300 s at 1000 ms is 300, 30 s at 250 ms is 120, 1800 s at 60000 ms is 30`.
  - `a ring keeps the newest values once full`: capacity 3, push 1 to 5 → `values()` `[3, 4, 5]`, `last()` some 5.
  - `a series created later is padded on the left with null`: tick ×3, the series `a` pushed on the three ticks, `b`
    only on the last → `dump().series` `{ a: [1, 2, 3], b: [null, null, 9] }`, `times` the three tick times.
  - `NaN is a gap (null) in the dump`.
  - `an empty history dumps at the clock's time`: `TestClock.setTime(42_000)` → `{ at: 42000, times: [], series: {} }`
    and its `intervalMs` and `capacity`.
  - `resized keeps the newest points of every series and of the times`: capacity 4 with 4 points → `resized(2, 500)`
    holds the last 2 of each, `intervalMs` 500.
- [ ] **Step 2:** `pnpm exec vitest run app/server/monitor/History.test.ts` fails.
- [ ] **Step 3: Implement** `app/server/monitor/History.ts`.
- [ ] **Step 4:** the test passes; `pnpm lint`, `pnpm check`, `pnpm test` green.
- [ ] **Step 5: Commit** `feat(server): Keep the monitor's history in rings`.

### Task 3: The model placement

**Files:**

- Modify: `app/server/supervisor/Supervisor.ts`, `app/server/logs/LogRing.ts` and their tests
- Create: `app/server/monitor/placement.ts`, `app/server/monitor/placement.test.ts`,
  `app/server/monitor/Placement.ts`, `app/server/monitor/Placement.test.ts`

**Interfaces:**

- Produces:
  - `Supervisor` gains `readonly changes: Effect.Effect<Stream.Stream<ServerState>, never, Scope.Scope>`: subscribed
    when the effect runs, then every new state in the order of the changes (published inside `change`, under the same
    lock as the `server-state` message).
  - `LogRing` gains `readonly batches: Effect.Effect<Stream.Stream<ReadonlyArray<LogLine>>, never, Scope.Scope>`: each
    batch the ring publishes as a `log` message, from the subscription on.
  - `placement.ts`: `RELEVANT: RegExp` (a line that can change the placement), `LAUNCH_MARK = '[llama-webui] launch:'`,
    `parsePlacement(lines: ReadonlyArray<LogLine>): ModelPlacement | null` (the rules of the E4 line "The placement is
    parsed from the log ring…").
  - `class Placement extends Context.Service<Placement, { readonly current: Effect.Effect<ModelPlacement | null> }>`,
    `Placement.layer: Layer.Layer<Placement, never, Supervisor | LogRing | WsHub>`.

The layer subscribes to both streams first, then computes the placement from the ring and the state once (no
message), then forks in its scope one fiber over `Stream.merge` of the two: on a state change, and on a batch holding
a `RELEVANT` line, it recomputes; the result is `null` unless the state is `starting`, `ready` or `stopping`; a
placement read while a pid ran stays while the same pid runs even when the launch line left the ring; a result whose
JSON differs from the held one is held and published as `placement`.

- [ ] **Step 1: Port the tests.** `placement.test.ts`: the eleven `parsePlacement:` tests of
      `app/server-legacy/lib/monitor/placement.test.ts`, same names, same fixtures, same assertions. `Placement.test.ts`
      (`layer(…, { excludeTestServices: true })`, a supervisor on the fake llama-server as in `Supervisor.test.ts`):
      the three `PlacementTracker:` tests renamed `Placement:` (replays the ring at construction without a message,
      follows new lines and the server state; an external server has no placement even if the ring holds an old
      launch; the launch evicted from the ring keeps the placement of the same server: a ring of capacity 5). Add to
      `Supervisor.test.ts` `changes streams every new state in order` (start then stop the fake: `starting`, `ready`,
      `stopping`, `idle`) and to `LogRing.test.ts` `batches streams what is published, from the subscription on`.
- [ ] **Step 2:** the new tests fail.
- [ ] **Step 3: Implement** `changes`, `batches`, `placement.ts`, `Placement.ts`. The parser follows the server's
      rules (Effect's `Array`, `String`, `Option`); port its regexes as they are.
- [ ] **Step 4:** the tests pass; `pnpm lint`, `pnpm check`, `pnpm test` green.
- [ ] **Step 5: Commit** `feat(server): Follow the model placement in llama-server's log`.

### Task 4: The hardware

**Files:**

- Create: `app/server/hardware/PciIds.ts`, `app/server/hardware/pci.ts`, `app/server/hardware/pci.test.ts`,
  `app/server/hardware/cpu.ts`, `app/server/hardware/cpu.test.ts`

**Interfaces:**

- Produces:
  - `class PciIds extends Context.Service<PciIds, { readonly name: (vendor: string, device: string) =>
    Effect.Effect<Option.Option<string>> }>`, `PciIds.layerWith({ files: ReadonlyArray<string> })`, `PciIds.layer`
    (files `/usr/share/hwdata/pci.ids`, `/usr/share/misc/pci.ids`, `/usr/share/pci.ids`). The first file that has the
    device names it, its bracketed name preferred; each file read once and kept for the process (a `Cache`, a missing
    file not kept: `Duration.zero` on failure); each `vendor:device` answer kept. Needs `FileSystem`.
  - `pci.ts`: the pure helpers (`parseLinkSpeed`, `minKnown`, `chipsetLabel`, `cpuLabel`, `findPciIdsEntry`,
    `isHostBridge`), `slotLink(options)` (used by the AMD reader, Task 6), and
    `readPciTopology(options?: { sysRoot?: string; procRoot?: string }): Effect.Effect<TopologyGraph, never,
    FileSystem | Path | PciIds>` (the rules of the `GET /api/topology` line; every failed read degrades, it never
    fails).
  - `cpu.ts`: `parseCpuinfo(text)`, `readCpuInfo(options?: { procRoot?: string; sysRoot?: string }):
    Effect.Effect<CpuInfo, never, FileSystem | Path>` (NUMA nodes 1 when unreadable, cores and threads at least 1).

- [ ] **Step 1: Port the tests.** `pci.test.ts`: the eight tests of `app/server-legacy/lib/hardware/pci.test.ts`, same
      names and fixtures (their sysfs trees written in a scoped temporary folder), `pciIdsEntry`'s file passed through
      `PciIds.layerWith`. Add `PciIds: a missing file is looked at again, a found name is not read twice` (a file
      created after the first miss is found; deleting it after a hit changes nothing) and `cpu.test.ts`:
      `readCpuInfo counts distinct physical cores, threads and NUMA nodes` (two sockets in a fake `cpuinfo`, `node0`
      `node1` `nodeX` in a fake sysfs → 2 nodes) and `readCpuInfo without sysfs counts one NUMA node`.
- [ ] **Step 2:** they fail.
- [ ] **Step 3: Implement** the three modules.
- [ ] **Step 4:** they pass; `pnpm lint`, `pnpm check`, `pnpm test` green.
- [ ] **Step 5: Commit** `feat(server): Read the PCIe graph, the CPU and pci.ids names`.

### Task 5: The machine and the process

**Files:**

- Create: `app/server/collectors/gpu.ts`, `app/server/collectors/system.ts`, `app/server/collectors/disk.ts`,
  `app/server/collectors/proc.ts`, `app/server/collectors/machine.test.ts`, `app/server/collectors/gpu.test.ts`

**Interfaces:**

- Produces:
  - `gpu.ts`: `GpuNeeds` (`{ gpus, pcie, skipGpus }`), `MEASURE_ALL`, `gpuNeeds(hiddenGpus)`, `gpuSkipped(needs,
    busId)`, `identityReading(g, 'suspended' | 'hidden')`, `normalizeBusId(id)`, `USED_GPU_THRESHOLD_BYTES` (64 MiB),
    `selectUsedGpus(gpus)`, and the interface every NVIDIA reader implements:

    ```ts
    export interface NvidiaReader {
      readonly gpus: Effect.Effect<ReadonlyArray<GpuReading>>;
      readonly procVram: (pid: number) => Effect.Effect<ReadonlyMap<string, number>>;
      readonly refreshApps: Effect.Effect<void>;
      readonly configure: (o: { readonly intervalMs: number; readonly needs: GpuNeeds }) => Effect.Effect<void>;
    }
    ```
  - `system.ts`: `parseProcStat`, `cpuPct(prev, cur)`, `parseMeminfo`, `parseLoadavg`, and
    `makeSystemSampler(options?: { procRoot?: string; sysRoot?: string }): Effect.Effect<{ readonly sample:
    Effect.Effect<SystemSample> }, never, FileSystem | Path>` (the previous CPU times in a `Ref`, 0 % on the first
    sample; the CPU sensor found once; each failed read is a null field).
  - `disk.ts`: `parseDiskstats`, `physicalDisks(sysBlockRoot?)`, `resolveModelDisk(path, options?: { sysRoot?: string
    }): Effect.Effect<Option.Option<string>, never, FileSystem | Path>` (the disk of the file's device, a partition
    resolved to its disk, none for tmpfs/btrfs/NFS), `makeDiskSampler({ disks, procRoot? })` → `{ sample: (modelDisk:
    string | null) => Effect.Effect<DiskSample> }` (rates against the previous sample and the `Clock`, 0 on the first).
  - `proc.ts`: `parseStat`, `parseRss`, `makeProcSampler(options?: { procRoot?: string })` → `{ sample: (pid: number)
    => Effect.Effect<Option.Option<{ cpuPct: number; rssBytes: number }>> }` (utime+stime at 100 ticks/s against the
    previous sample of the same pid).

`resolveModelDisk` needs the device number of a file: `FileSystem.stat` gives `dev`; read in
`repos/effect/packages/effect/src/FileSystem.ts` how (`File.Info`), and fall back to `/proc/self/mountinfo` only if
it does not.

- [ ] **Step 1: Write the failing tests.** `gpu.test.ts`: port `normalizeBusId` and `selectUsedGpus` from
      `nvidia.test.ts`. `machine.test.ts` (fake `/proc` and `/sys` trees in a scoped temporary folder,
      `excludeTestServices: false`: the `TestClock` moves the disk rates):
  - `the system sampler gives total and per-core CPU from two reads of /proc/stat`;
  - `the system sampler reads meminfo, loadavg, the mean scaling_cur_freq and the first k10temp sensor`;
  - `an unreadable file is a null field, not a failure` (no `meminfo` → `mem: null`, the rest read);
  - `the disk sampler gives read and write rates per disk, their sum and the model disk's, 0 on the first sample`
    (`TestClock.adjust('1 second')` between two `diskstats`);
  - `physicalDisks lists /sys/block without loop, ram and zram, and only entries with a device`;
  - `resolveModelDisk resolves a partition to its disk` (a fake `/sys/dev/block/<maj>:<min>` with `partition`);
  - `the process sampler gives CPU % from utime+stime and RSS from VmRSS`, `a pid that is gone gives none`.
- [ ] **Step 2:** they fail.
- [ ] **Step 3: Implement** the four modules.
- [ ] **Step 4:** they pass; `pnpm lint`, `pnpm check`, `pnpm test` green.
- [ ] **Step 5: Commit** `feat(server): Sample the machine, its disks and llama-server's process`.

### Task 6: The AMD cards

**Files:**

- Create: `app/server/collectors/amdgpu.ts`, `app/server/collectors/amdgpu.test.ts`

**Interfaces:**

- Consumes: `slotLink`, `parseLinkSpeed` (Task 4), `PciIds` (Task 4), `identityReading` (Task 5).
- Produces: `AmdCard` (as legacy), `parseFdinfo`, `parseDpm`, `discoverAmdCards(options?: { drmRoot?: string })`,
  `readAmdCard(card)`, `isRuntimeSuspended(card)`, `suspendedAmdReading(card)`, `hiddenAmdReading(card)`,
  `readProcAmdVram(pid, options: { procRoot?: string; skipNodes: ReadonlySet<string> })`: each an `Effect` needing
  `FileSystem`, `Path` (and `PciIds` for `discoverAmdCards`); a failed read degrades as in the legacy module.

- [ ] **Step 1: Port the tests:** the fourteen tests of `app/server-legacy/lib/collectors/amdgpu.test.ts`, same names
      and sysfs fixtures; `parseLinkSpeed` moves to `pci.test.ts` if Task 4 already holds it (keep one copy, the
      inventory says where). `pciIdsName` becomes `PciIds` behind `discoverAmdCards`: its test keeps its name and
      asserts the card's name.
- [ ] **Step 2:** they fail. **Step 3: Implement.** **Step 4:** they pass; `pnpm lint`, `pnpm check`, `pnpm test`
      green.
- [ ] **Step 5: Commit** `feat(server): Read the AMD cards from sysfs`.

### Task 7: nvidia-smi and perf

**Files:**

- Create: `app/server/collectors/nvidia.ts`, `app/server/collectors/nvidia.test.ts`,
  `app/server/collectors/membw.ts`, `app/server/collectors/membw.test.ts`

**Interfaces:**

- Produces:
  - `nvidia.ts`: `parseNvidiaGpuLine(line): Option.Option<GpuReading>`, `parseComputeApps(csv)`,
    `makeNvidiaSmi(options: { bin: string; intervalMs: number; appsTimeout?: Duration.Input }): Effect.Effect<
    NvidiaReader & { readonly available: Effect.Effect<boolean> }, never, Scope | ChildProcessSpawner | …>`. One
    long-lived `nvidia-smi --query-gpu=… --format=csv,noheader,nounits -lms <interval>` in a scope of its own, its lines
    grouped into cycles (a cycle ends when a bus id repeats), the last cycle kept when the stream dies (not
    restarted); a spawn failure makes it unavailable for good. `configure` restarts a running stream at the new
    interval, and only when the interval changed. `refreshApps` runs `--query-compute-apps=pid,gpu_uuid,used_memory`
    under `appsTimeout` (3 s; the timeout kills it), one at a time (`Semaphore`, a call while one runs returns at once),
    keeping the previous mapping on a timeout or a failure. `procVram(pid)` from that mapping, `[N/A]` counting the
    card's whole VRAM in use.
  - `membw.ts`: `SYSTEM_EVENTS`, `PROC_EVENT`, `BYTES_PER_EVENT` (64), `parsePerfLine(line)`,
    `makeMemBandwidth(options: { bin?: string; intervalMs: number; retryAfter?: Duration.Input }):
    Effect.Effect<MemBandwidthSampler, never, Scope | ChildProcessSpawner>` where `MemBandwidthSampler` is `{
    readonly sample: Effect.Effect<MemBandwidth | null>; readonly procSample: Effect.Effect<number | null>; readonly
    setPid: (pid: number | null) => Effect.Effect<void>; readonly configure: (intervalMs: number) =>
    Effect.Effect<void> }`: two `perf stat -x , --log-fd 1 -I <interval>`
    streams (system `-a -e umc_cas_cmd.rd,umc_cas_cmd.wr`, process `-p <pid> -e ls_any_fills_from_sys.dram_io_all`),
    each in its own scope; values stale after 3 intervals; a dead or failing stream started again no sooner than
    `retryAfter` (60 s); a pid perf could never attach to not retried; `setPid` replaces the process stream when the
    pid changes; `configure` restarts both at the new interval. Its scope's end stops them.

- [ ] **Step 1: Port the tests:** the nine `nvidia.test.ts` tests that are not `normalizeBusId`/`selectUsedGpus`
      (Task 5) and the eight `membw.test.ts` tests, same names and assertions, each fake program a shell script in a
      scoped temporary folder (`flags/Flags.test.ts` shows how) that writes its lines with pauses and records its
      arguments and its starts in a file. Delays shortened through the options (`retryAfter: '300 millis'`,
      `appsTimeout: '300 millis'`). Each test asserts its fakes are dead at the end (no pid of the records alive).
- [ ] **Step 2:** they fail. **Step 3: Implement.** **Step 4:** they pass; `pnpm lint`, `pnpm check`, `pnpm test`
      green.
- [ ] **Step 5: Commit** `feat(server): Read nvidia-smi and perf as long-lived programs`.

### Task 8: The NVML sampler

**Files:**

- Create: `app/server/collectors/nvml/protocol.ts`, `app/server/collectors/nvml/symbols.ts`,
  `app/server/collectors/nvml/read.ts`, `app/server/collectors/nvml/worker.ts`, `app/server/collectors/nvml/Nvml.ts`,
  `app/server/collectors/nvml/Nvml.test.ts`, `app/server/testing/fixtures/fakeNvml.ts`
- Modify: `app/build/server.ts`, `app/server/build.test.ts`

**Interfaces:**

- Produces:
  - `protocol.ts`: `ToSampler` = `Union([{ type: 'start', intervalMs, needs, lib: optionalKey(String) }, { type:
    'configure', intervalMs, needs }])`, `FromSampler` = `Union([{ type: 'ready' }, { type: 'error', message }, { type:
    'sample', snapshot: NvmlSnapshot }])`, `NvmlSnapshot` (`gpus: Array(GpuReading)`, `procs: Array({ pid, key,
    usedBytes: NullOr(Finite) })`, `system: NvmlSystem`), `NvmlSystem` (`{ driver: NullOr(String), cudaDriver:
    NullOr(Int) }`).
  - `symbols.ts`: `openNvml(path?: string): NvmlSymbols` (the `node:ffi` import, with the one directive). `read.ts`:
    `deviceHandles`, `readNvml(lib, handles, needs): NvmlSnapshot`, `readNvmlSystem` (ported, server rules; handles are
    `bigint`, never sent).
  - `worker.ts`: the child program, run by `NodeRuntime.runMain` on `NodeServices.layer`: decodes `ToSampler` lines
    from `Stdio.stdin`, on `start` opens the library and inits it (an `error` message on failure, then it stays idle),
    sends `ready`, then samples every `intervalMs` (at least 100 ms, drift-compensated: each wait is the interval minus
    the round's time), writing `FromSampler` lines to stdout; `configure` changes the interval and the needs from the
    next round; the end of stdin ends the program (exit 0).
  - `Nvml.ts`: the reducer and the reader:

    ```ts
    export interface NvmlState { readonly gpus: ReadonlyArray<GpuReading>; readonly procs: …; readonly system:
      NvmlSystem | null; readonly lastSampleAt: number; readonly intervalMs: number; readonly freshIntervalMs: number;
      readonly dead: boolean }
    export const onSample: (state: NvmlState, snapshot: NvmlSnapshot, now: number) => NvmlState;
    export const onConfigure: (state: NvmlState, intervalMs: number) => NvmlState; // fresh = max(old, new)
    export const isFresh: (state: NvmlState, now: number) => boolean;  // now − lastSampleAt ≤ 3 × freshIntervalMs
    export const procVramOf: (state: NvmlState, pid: number) => ReadonlyMap<string, number>; // null usedBytes → card's used VRAM
    export const workerPath: (moduleUrl: string) => string; // ./worker.ts next to a .ts module, ./nvml-worker.mjs next to a bundle
    export const startNvml: (options: { intervalMs: number; needs: GpuNeeds; lib: Option.Option<string>;
      command?: { readonly cmd: string; readonly args: ReadonlyArray<string> }; readyTimeout?: Duration.Input }) =>
      Effect.Effect<Option.Option<NvidiaReader & { readonly system: Effect.Effect<NvmlSystem | null> }>, never,
      Scope.Scope | ChildProcessSpawner.ChildProcessSpawner>;
    ```

    `startNvml` spawns the worker (default `process.execPath`, `--disable-warning=ExperimentalWarning`,
    `workerPath(import.meta.url)`) into a scope of its own forked from the caller's, sends `start`, and waits for
    `ready` up to `readyTimeout` (3 s): none (and the child killed) on a timeout, an `error` or an exit before it.
    After `ready`, samples update a `Ref<NvmlState>`; an `error` or an exit clears the readings for good (`dead`: no
    restart, no switch to nvidia-smi). `gpus` and `procVram` answer nothing when the readings are stale.
    `refreshApps` is `Effect.void` (processes come with each sample). The scope's end kills the child with SIGKILL.
- Build: `app/build/server.ts` bundles `server/collectors/nvml/worker.ts` to `.output/server/nvml-worker.mjs` (one
  file, Node builtins only), next to `index.mjs`.

- [ ] **Step 1: Write the failing tests.** `Nvml.test.ts`:
  - port `lowering the interval keeps the last sample fresh until the worker samples at the new pace` on the reducer
    (`onConfigure` then `isFresh` at `lastSampleAt + 3 × old interval`: fresh; after `onSample` at the new interval:
    judged on the new one);
  - port `workerUrl: worker.ts next to the module in development, nvml-worker.mjs next to the bundle` as
    `workerPath: …`;
  - `a process VRAM NVML cannot report counts the card's VRAM in use` (not covered before);
  - `stale readings give no GPU and no process VRAM`;
  - on real time, with `app/server/testing/fixtures/fakeNvml.ts` (a Node script that speaks the protocol; its
    behaviour chosen by an argument: `ready-then-sample`, `error`, `silent`, `exit-after-ready`) as `command`:
    `a sampler that answers ready gives its readings`, `a sampler that never answers is given up after the ready
    timeout and killed` (`readyTimeout: '300 millis'`), `a sampler that errors gives none`, `a sampler that exits
    after ready clears its readings for good`, `a sampler exits when its stdin ends` (the fake, run alone, exits 0
    once its stdin is closed);
  - port `a real worker with a missing NVML library resolves null (the nvidia-smi fallback)` (the real `worker.ts`,
    `lib: Option.some('/no/such/libnvidia-ml.so')`) and `a real worker reads NVML when the library is here` (skipped
    when `libnvidia-ml.so.1` is not found under `/usr/lib*`), and `a sampler stuck in a native call does not hold the
    process when it exits` (a fake whose loop is a busy wait: the scope's end kills it at once, under 500 ms).
  - `build.test.ts`: port `the NVML sampler ships next to the server entry and starts from the bundle` (spawn
    `node .output/server/nvml-worker.mjs`, write a `start` with a missing library, read an `error` line) and `the
    server finds the NVML sampler: the module that names it sits next to it` (the bundle holds `nvml-worker.mjs` and
    `.output/server/` holds both files).
- [ ] **Step 2:** they fail.
- [ ] **Step 3: Implement** the five modules and the build entry.
- [ ] **Step 4:** they pass; `pnpm build` writes `nvml-worker.mjs`; `pnpm lint`, `pnpm check`, `pnpm test` green.
- [ ] **Step 5: Commit** `feat(server): Sample NVML in a child process spoken to in NDJSON`.

### Task 9: The collectors

**Files:**

- Create: `app/server/collectors/Collectors.ts`, `app/server/collectors/Collectors.test.ts`

**Interfaces:**

- Consumes: Tasks 5 to 8.
- Produces:

  ```ts
  export type CollectorSettings = Pick<Settings, 'collectors' | 'pollIntervalMs' | 'hiddenGpus'>;
  export class CollectorsNotApplied extends Schema.TaggedError<…>()('CollectorsNotApplied', { message: Schema.String }) {}
  export class Collectors extends Context.Service<Collectors, {
    readonly nvidia: NvidiaReader;
    readonly nvidiaSource: NvidiaSource;                       // 'nvml' | 'nvidia-smi', chosen once
    readonly nvmlSystem: Effect.Effect<NvmlSystem | null>;     // null with nvidia-smi
    readonly amd: { readonly cards: ReadonlyArray<AmdCard>; readonly read, procVram, suspended };
    readonly proc: (pid: number) => Effect.Effect<Option.Option<{ cpuPct: number; rssBytes: number }>>;
    readonly system: Effect.Effect<Option.Option<{ sample: …; memBw: MemBandwidthSampler }>>;  // the switch as it is now
    readonly disk: Effect.Effect<Option.Option<{ sample: …; resolveModelDisk: … }>>;
    readonly configure: (settings: CollectorSettings) => Effect.Effect<void, CollectorsNotApplied>;
  }>()('@llama-webui/app/server/collectors/Collectors') {
    static readonly layerWith: (options: { initial: CollectorSettings; nvmlLib: Option.Option<string>;
      nvidiaSmi: string; … durations }) => Layer.Layer<Collectors, never, ChildProcessSpawner | FileSystem | Path | PciIds>;
    static readonly layer: Layer.Layer<Collectors, Config.ConfigError, SettingsRepo | ChildProcessSpawner | FileSystem | Path | PciIds>;
  }
  ```

  `layer` reads the settings from `SettingsRepo`, `LLAMA_WEBUI_NVML_LIB` and `LLAMA_WEBUI_NVIDIA_SMI` with `Config`
  (an empty value is unset; default the system's library and `nvidia-smi`). Startup, in order: NVML when
  `collectors.nvml` (awaiting `ready`), else nvidia-smi; the AMD cards discovered once; `configure(initial)`; then
  nvidia-smi started if it is the source. `configure` (one at a time, `Semaphore.withPermits(1)`) passes the interval
  and the needs to the NVIDIA reader, switches the system sampler and perf (off stops perf), switches the disk sampler
  (on lists the disks again). `collectors.nvml` is read at startup only.

- [ ] **Step 1: Write the failing tests** (real time; `nvmlLib` a missing path, `nvidiaSmi` a fake script or a missing
      path, perf a missing `bin`):
  - `with no NVML library and no nvidia-smi, the collectors start and read no GPU` (Review Focus): `nvidiaSource`
    `nvidia-smi`, `nvidia.gpus` empty, the smi fake's record shows no second start after a while;
  - `collectors.nvml off starts nvidia-smi without trying NVML` (the fake records its start);
  - `collectors.nvml is read at startup only`: `configure` with `nvml: true` after a start with it off keeps
    `nvidia-smi`;
  - `the system and disk switches apply live`: `configure` with `system: false` → `system` none and the perf fake
    dead; `disk: false` → `disk` none; back on → some;
  - `configure calls run one at a time` (two concurrent calls, the second sees the first's result).
- [ ] **Step 2:** they fail. **Step 3: Implement.** **Step 4:** they pass; `pnpm lint`, `pnpm check`, `pnpm test`
      green.
- [ ] **Step 5: Commit** `feat(server): Gather the collectors and follow their settings`.

### Task 10: The monitor

**Files:**

- Modify: `app/server/llama/probes.ts`, `app/server/llama/probes.test.ts`
- Create: `app/server/monitor/tick.ts`, `app/server/monitor/tick.test.ts`, `app/server/monitor/Monitor.ts`,
  `app/server/monitor/Monitor.test.ts`

**Interfaces:**

- Consumes: `History` (Task 2), `Collectors` (Task 9), `Supervisor.state`, `ProfilesRepo.get`, `profilePaths`,
  `WsHub.publish`.
- Produces:
  - `probes.ts`: `readLlama(target: Target): Effect.Effect<LlamaRaw, never, LlamaHttp>`: `/health` (200 `ok`, 503
    `loading`, else `error`; nothing within 800 ms `down`), then when `ok` `/slots` (`parseSlots`) and `/metrics`
    (`parsePrometheus`) concurrently, each 800 ms at most and null on any failure; `at` from the `Clock`.
  - `tick.ts`, pure:

    ```ts
    export interface TickMemory { tickNo; lastPid: number | null; ticksForPid; prevRaw: LlamaRaw | null;
      prevMetrics: ReadonlyMap<string, number> | null; lastRequest; recentRequests; spec }
    export const initialMemory: TickMemory;
    /** Before the reads: a new pid resets every counter (no rate across two processes); counts the tick. */
    export const beginTick: (memory: TickMemory, pid: number | null, active: boolean) => TickMemory;
    export interface TickReading { at: number; active: boolean; pid: number | null; raw: LlamaRaw | null;
      allGpus: ReadonlyArray<GpuSample>; proc: { cpuPct; rssBytes } | null; dramBps: number | null;
      system: Option<SystemSample | null>; disk: Option<DiskSample | null>  /* none: collector off */;
      memBw: MemBandwidth | null }
    /** Pushes one point per series into `history` and builds the snapshot. */
    export const endTick: (memory: TickMemory, history: History, reading: TickReading) =>
      { readonly memory: TickMemory; readonly snapshot: Snapshot };
    ```

    The series rules are the E4 lines "Every tick appends one point…", "A tick without an active server…" and the
    `known`/`push`/`finish` logic of `app/server-legacy/lib/monitor/monitor.ts`. Every number of the snapshot is finite:
    a non-finite value becomes `null` where the field is nullable, else `0`.
  - `class Monitor extends Context.Service<Monitor, { readonly latest: Effect.Effect<Snapshot | null>; readonly history:
    Effect.Effect<HistoryDump>; readonly nvidiaSource: NvidiaSource; readonly nvmlSystem: Effect.Effect<NvmlSystem |
    null>; readonly configure: (settings: MonitorSettings) => Effect.Effect<void, CollectorsNotApplied> }>`, with
    `MonitorSettings = Pick<Settings, 'collectors' | 'pollIntervalMs' | 'historySeconds' | 'hiddenGpus'>` and:
    - `Monitor.layerWith(options: { modelDiskRetry: Duration.Input; appsEvery: number })`: needs `Collectors`,
      `Supervisor`, `SettingsRepo`, `ProfilesRepo`, `WsHub`, `LlamaHttp`, `Path`. One fiber of the layer's scope:
      tick at once, then wait `pollIntervalMs` (read anew each round) minus the tick's time, forever: one tick at a
      time, the first one not holding the start of the app. A tick: state → pid; `beginTick`; when active, on the
      first tick of a pid `nvidia.refreshApps` awaited, on every `appsEvery`-th forked; perf follows the pid
      (`memBw.setPid`, every tick); then concurrently llama-server
      (`readLlama` at `stateHost`/`port`), the GPUs (the `collectGpus` rules: hidden and suspended cards identity
      only, their DRM nodes skipped for fdinfo), the process, perf, system and disk; `endTick`; the snapshot held and
      published as `snapshot`. A tick that fails or dies is logged (`monitoring tick`) and the loop goes on.
    - The model disk: per profile id, looked up in a fiber of the layer's scope (never awaited by a tick), retried
      `modelDiskRetry` (30 s) after a miss, null for an external or crashed server, or with the disk collector off.
    - `configure`: `collectors.configure` first; only then the settings become current, the history is resized when
      `historySeconds` or `pollIntervalMs` changed, and the next wait uses the new interval.
    - `Monitor.layerStub`: no collector, no fiber: `latest` null, `history` `{ intervalMs: 1000, capacity: 0, at: 0,
      times: [], series: {} }`, `nvidiaSource` `nvml`, `nvmlSystem` null, `configure` `Effect.void`.
    - `Monitor.layer`: `LLAMA_WEBUI_TEST_MONITOR` (`Config`, exactly `stub`) picks `layerStub`; otherwise
      `layerWith({ modelDiskRetry: '30 seconds', appsEvery: 5 })` with `Collectors.layer` provided inside it (the
      stub builds no collector; the collectors end right after the monitor).

- [ ] **Step 1: Write the failing tests.**
  - `probes.test.ts` (`httpStub` of `testing/llama.ts`): `readLlama reads health, slots and metrics of a loaded
    server`, `readLlama stops at a loading server` (503 → `loading`, no `/slots` request), `a llama-server that never
    answers gives health down within a second` (part one of the Review Focus line).
  - `tick.test.ts` (plain tests on a `History`): `an idle tick pushes 0 for the llama series and repeats the last
    acceptance`, `a new pid resets the counters` (no rate from the old raw, `recentRequests` empty), `a series starts
    at its first known value and an existing one not fed gets a gap`, `GPU util is a gap for a hidden or suspended
    card`, `a collector turned off leaves gaps in its series`, `points carry this tick's values with NaN as null`,
    `a tick fed non-finite readings still encodes as a Snapshot` (Review Focus: `Schema.encodeUnknownEffect(Snapshot)`
    succeeds on a reading with `NaN` util, `Infinity` rates and a card of 0 total VRAM).
  - `Monitor.test.ts` (real time, `pollIntervalMs` 250 through the settings, a `Collectors` built by `layerWith` with
    missing programs, the fake llama-server for an active state): `the first snapshot is published and served by
    latest`, `the next tick comes after a llama-server that never answers` (part two of the Review Focus line: an
    `httpStub` that never answers as an external server → two snapshots within 2 s, `health: 'down'`), `configure
    resizes the history keeping the newest points and moves the next tick to the new interval` (Review Focus),
    `settings become current only once the collectors accepted them` (a `Collectors` whose `configure` fails: the
    history keeps its shape), `a model disk lookup that never ends does not hold a tick` (a resolver that never
    answers: snapshots keep coming, `disk.model` null), `the stub answers an empty history and no snapshot`.
- [ ] **Step 2:** they fail. **Step 3: Implement** `readLlama`, `tick.ts`, `Monitor.ts`. **Step 4:** they pass;
      `pnpm lint`, `pnpm check`, `pnpm test` green.
- [ ] **Step 5: Commit** `feat(server): Tick the monitor and keep its history`.

### Task 11: The monitor over HTTP

**Files:**

- Create: `app/server/monitor/http.ts`, `app/server/monitor/http.test.ts`
- Modify: `app/server/settings/http.ts`, `app/server/settings/http.test.ts`, `app/server/http/HttpLive.ts`,
  `app/server/App.ts`, `app/server/testing/services.ts`, `app/server/contract/cases.ts`,
  `app/server/contract/contract.test.ts`, `app/server/contract/golden.json`, `app/server/lifecycle.test.ts`

**Interfaces:**

- Produces: `MonitorHandlers` (group `monitor`): `history` = `monitor.history` and `AppInfo.bootId`; `snapshot` =
  `monitor.latest`; `systemInfo` = `readCpuInfo()` run once per process (`Effect.cached` when the group is built),
  the identity of each card of the latest snapshot's `allGpus` (`[]` before it), `monitor.nvidiaSource`; `topology` =
  `readPciTopology()` on every call and `placement.current`. `SettingsHandlers.patch`: `repo.patch`, then
  `monitor.configure(next)`; on `CollectorsNotApplied` the reply is `{ ...next, warning: 'Saved, but the monitor could
  not apply it: <message>' }` and the warning is logged (`Effect.logWarning`).
- `Services` of `App.ts`, from the top: `ExternalWatch`, then `Layer.merge(Monitor.layer, Placement.layer)`, then the
  supervisor and the tiers below; `PciIds.layer` joins the tier of `LogRing` and `LlamaHttp`. The monitor and the
  placement end before the supervisor stops llama-server, the collectors' programs with the monitor.
- `ServicesTest`: `Monitor.layerStub`, `Placement.layer`, `PciIds.layer`.

- [ ] **Step 1: Write the failing tests.**
  - `monitor/http.test.ts` (`HttpApiTest` on `ServicesTest`, as `settings/http.test.ts`): `history answers the stub's
    dump and this boot's id`, `snapshot answers null before any tick`, `system info lists the CPU, no GPU before a
    snapshot, and nvml with the stub`, `topology answers a graph with the CPU and RAM and no placement`.
  - `settings/http.test.ts`: port `PATCH /api/settings: saved but not applied by the monitor is a 200 with a warning,
    not a 500 (#35)` (a `Monitor` stand-in whose `configure` fails with `CollectorsNotApplied`: 200, the settings saved,
    `warning` `Saved, but the monitor could not apply it: <message>`).
  - `lifecycle.test.ts`: `SIGTERM with the monitor's programs running leaves none of them` (Review Focus: the build
    launched with the real monitor, `LLAMA_WEBUI_NVML_LIB` a missing path, `LLAMA_WEBUI_NVIDIA_SMI` a fake script that
    prints a GPU line every 100 ms and records its pid, a page open on `/ws` that received a `snapshot`; SIGTERM → exit
    under 2 s, the recorded pid dead).
  - Contract: `launch()` of `contract.test.ts` gets `LLAMA_WEBUI_TEST_MONITOR=stub`; `add` takes a `machine` flag that
    records `fields` (the sorted keys of the body) instead of the body; cases `GET /api/monitor/history`,
    `GET /api/monitor/snapshot` (read), `GET /api/system/info` and `GET /api/topology` (read, machine).
- [ ] **Step 2:** they fail.
- [ ] **Step 3: Implement** the handlers, the settings change, the wiring.
- [ ] **Step 4:** `UPDATE_GOLDEN=1 pnpm exec vitest run app/server/contract/contract.test.ts`, then read the diff of
      `golden.json`: the four new cases only (history `{ intervalMs: 1000, capacity: 0, at: 0, times: [], series: {},
      bootId: '<bootId>' }` or the run's normalized id, snapshot `null`, the two machine cases as field lists), no other
      case changed. `pnpm lint`, `pnpm check`, `pnpm test` green.
- [ ] **Step 5: Commit** `feat(server): Serve the monitor, the system information and the topology`.

### Task 12: The Dashboard, System and Topology pages

**Files:**

- Modify: `app/src/lib/monitor.ts`, `app/src/lib/topology.ts`, `app/src/lib/settings.ts`,
  `app/src/features/system/SystemPage.tsx`, `app/src/main.tsx`, `app/src/app/router.tsx`, `app/src/app/routes.ts`,
  `app/tsconfig.json` (if a test of these pages is excluded), and the page components the readonly types reach
- Delete: nothing; `ChecksCard.tsx` stays in the tree, unrouted
- Modify: `docs/superpowers/poc-effect/behaviours.md` (the `From E4:` line of the Checks card in the E8 section)

**Interfaces:**

- Consumes: `call((api) => api.monitor.history())`, `api.monitor.systemInfo()`, `api.monitor.topology()`,
  `api.settings.patch(…)` answering `SettingsPatched`; the `snapshot` and `placement` messages through `onWs`.

- [ ] **Step 1:** Move the three stores and `SystemPage.tsx` to `call`, call `startMonitorSync()` and
      `startTopologySync()` in `main.tsx`, put `/dashboard`, `/system` and `/topology` in `PORTED` and out of
      `MILESTONE_BY_PATH`, remove `ChecksCard` from the System page, and show the patch `warning` as a toast again
      (`toast.warning`, no success toast then). Errors are told by `_tag`, never by message.
- [ ] **Step 2:** `pnpm check` and the web tests (`pnpm exec vitest run --project web`) green; `pnpm build`.
- [ ] **Step 3: Look at the pages.** Launch the build on a scratch data folder and a free port (`node
      app/.output/llama-webui.mjs --host 127.0.0.1 --port <free> --data-dir <tmp>`), open `/dashboard`, `/system` and
      `/topology` in Chromium (Playwright, `deviceScaleFactor: 1`): each renders without an error in the console, the
      Dashboard's charts move with the snapshots, the System page shows the CPU and the memory, Topology the CPU and
      RAM nodes; start the fake llama-server through the API (`startFakeThrough` of `testing/llama.ts`) and see the
      Dashboard's llama-server part and the Topology's placement (null for the fake: no loading lines) answer. Record
      what was seen for the report.
- [ ] **Step 4:** `pnpm lint`, `pnpm check`, `pnpm test` green.
- [ ] **Step 5: Commit** `feat(web): Bring the Dashboard, System and Topology pages back`.

### Task 13: Close the milestone

**Files:**

- Modify: `docs/superpowers/poc-effect/behaviours.md`, `test-inventory.json`, `defects.md`, `conventions.md`,
  `CLAUDE.md` (only where a rule a contributor needs changed: the NVML sampler, `LLAMA_WEBUI_TEST_MONITOR`)
- Delete: the legacy files listed below
- Create: `docs/superpowers/poc-effect/e4.json`

- [ ] **Step 1: Behaviours.** Section E4: every line ticked with what proves it (a test by its file and name, or a
      contract case), in the format of sections E1 to E3; a line that changed says how it behaves now (the calls at the
      top of this plan); every "Not covered by a test" line ticked with the test this plan added, or moved. The `From
      E3:` line ticked. Moved, as a `From E4:` line in the section of its milestone: to **E8** the Checks card of the
      System page (Task 12) and the monitor's latest memory and GPUs read by the launchpad and the tuning hardware;
      to **E7** the pause of the monitor's reads during a benchmark if the legacy code had one (check
      `app/server-legacy/lib/bench/`), else nothing.
- [ ] **Step 2: Tests.** In `test-inventory.json`, the seventy `E4` entries get a status (a throwaway script, never
      regenerated; `0` left without one): `ported` when the test kept its name and assertions (placement, pci, amdgpu,
      nvidia, membw, topology), `rewritten` with its new place when its subject changed shape (`nvml/monitor.test.ts`
      on the reducer and the fake sampler, `workerUrl` as `workerPath`, `pciIdsName` behind `discoverAmdCards`, the
      `PlacementTracker` tests as `Placement`, the `#35` test in `settings/http.test.ts`, the two `build.test.ts`),
      `dropped` only with a reason.
- [ ] **Step 3: Defects and deviations.** In `defects.md`, section E4: `The Monitor class has no direct test` →
      `fixed in E4` (the tick tests); `Ring.max() and the gpus: false branch are never reached` → `confirmed`, `max()`
      not ported, `gpus: false` kept as the legacy shape of `GpuNeeds` only if a caller sets it, else removed (say
      which); `An NVML child that fails once it is ready is never started again` and `collectors.nvml is only read at
      startup` → `design choice` (ported as they are, tested). Under "Changed by the Effect server", one line per call
      at the top of this plan and one per deviation found while porting.
- [ ] **Step 4: Conventions.** Add to `conventions.md`, from the code as it is now (a few lines each): a child program
      spoken to in NDJSON (`protocol.ts`, stdin's end as the exit, the one `node:ffi` directive, its bundle next to
      `index.mjs`); a pure step with its I/O around it (`tick.ts`, `Nvml.ts`'s reducer) and why it is tested without
      timers; following a service's changes (`changes`/`batches`: subscribe, then read, then follow); every number a
      schema sends is finite; recording a machine-dependent reply in the contract (`machine`).
- [ ] **Step 5: Legacy files.** Delete (`git rm`) what this milestone rewrote: `app/server-legacy/lib/monitor/`,
      `lib/collectors/`, `lib/hardware/pci.ts`, `lib/hardware/pci.test.ts`, `lib/hardware/cpu.ts` (check that no other
      legacy file of a later milestone imports it: `grep -rn "hardware/cpu" app/server-legacy` — keep it if `lib/tuning/`
      or `lib/bench/` does), `lib/testing/stubMonitor.ts`, `routes/api/monitor/`, `routes/api/system/`,
      `routes/api/topology.get.ts`. Keep `lib/boot.ts`, `lib/context.ts`, `lib/deps.ts`, `lib/routes.test.ts`.
- [ ] **Step 6: Run everything, commit.**
      `pnpm lint && pnpm check && pnpm test && pnpm build && node scripts/smoke.ts`, then
      `pnpm check 2>&1 | grep -c 'effect('` (expected `0`), then `pgrep -f 'fake-llama-server|fakeNvml|nvml-worker'`
      (expected nothing). Commit `chore(poc): Close E4, the monitoring`.
- [ ] **Step 7: Measure, on the clean tree.**
      `node scripts/poc/measure.ts --out docs/superpowers/poc-effect/e4.json`, then
      `pnpm exec biome format --write docs/superpowers/poc-effect/e4.json`, commit `chore(poc): Measure E4`.
- [ ] **Step 8: Report.** What was built per task; every deviation from this plan and why; every place the plan was
      wrong about Effect or the tree; every behaviour dropped, changed or moved; the `@effect-diagnostics` directives
      and override entries (expected: the `node:ffi` one and the two shared modules); what Task 12 Step 3 showed; the
      numbers of `e4.json` next to `e3.json` (the size of `nvml-worker.mjs` among them); anything left undone.
