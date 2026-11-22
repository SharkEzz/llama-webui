# Profiling tool implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `pnpm profile <scenario…>` measures the app on a production build and writes a self-contained HTML report
that can compare the run with a reference run.

**Architecture:** A Node CLI in `scripts/profiling/`. It builds, starts the server under the inspector and a headless
Chromium, runs the requested scenarios (each returns a typed result made of measure windows), writes `results.json`,
and renders `report.html` from it. Every comparable number is a `Figure` with a stable id: the comparison joins two
runs on those ids and the report prints the reference and the difference next to each one.

**Tech Stack:** Node 26 (erasable TypeScript, `node:util` `parseArgs`, `node:module` `SourceMap`, global `WebSocket`),
`puppeteer-core` 25, Chrome DevTools Protocol, Vitest.

**Spec:** `docs/superpowers/specs/2026-11-22-profiling-tool-design.md`. The throwaway scripts it names are untracked:
read them at `/home/tristan/DEV/llama-webui/.cache/profiling/2026-11-22/` (absolute path: a worktree does not have
`.cache`). "Port `x` of `lib.ts`" below means: same behaviour and same computation, rewritten to the constraints here.

## Global Constraints

- Branch `feat/profiling-tool` from `master`; one PR; the spec and this plan are committed with Task 1.
- Nothing under `app/`, `packages/` or `repos/` is modified. The tool reads `app/server/collectors/` and imports
  `app/server/collectors/nvml/{symbols,read}.ts` (Task 9), nothing else from the app.
- All code in `scripts/profiling/`. No `any`, no cast of an untyped value (`typescript/no-unsafe-type-assertion` is on
  outside tests): a JSON read from the API, CDP or a file is narrowed by guards. Relative imports end in `.ts`; erasable
  syntax only (no `enum`, no parameter property).
- A rule that reports a deliberate sequential `await` in a measure loop gets the targeted, reasoned suppression
  `CLAUDE.md` describes; no rule is turned off.
- CLI messages, the report, comments, test names, commits and the PR are in English. Numbers in the report go through
  one formatter on `en-US`.
- The CPU headline figures come from windows without a profiler; a window taken under a profiler has
  `profiled: true` and the report labels it.
- Defaults: `--host 127.0.0.1`, `--port 7860`, `--chrome /usr/bin/chromium`, data directory the app's default, profile
  the instance's `defaultProfileId`. Runs live in `.cache/profiling/<run>/`; an existing run name is refused.
- Noise thresholds (one table, `NOISE` in `compare.ts`): CPU and main-thread shares 0.5 point; tokens per second 1 %;
  durations 10 % and at least 1 ms; sizes 5 % and at least 1 KiB; counts 5 % and at least 1; `gpu_busy_percent` is
  indicative and never reported as changed.
- Tests only for the hot paths the spec lists (profile aggregation, `/proc` CPU, comparison, report). No test starts a
  server, a model or a browser. Run one file with
  `LLAMA_WEBUI_TEST_BUILD=0 pnpm exec vitest run scripts/profiling/<file>.test.ts` (reuses `app/.output`; run
  `pnpm build` once first).
- Before each commit: `pnpm lint` and `pnpm check` green. Before the PR: `pnpm test` too.
- Commit messages end with `Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>`.
- Scenarios with a model use the user's GPUs and port 7860: Tasks 6 to 9 and 11 run them on the real instance, with the
  user's everyday instance stopped. The full pass of Task 11 needs the user's go-ahead.

## Review Focus

Inputs the spec implies and that would bite; each is pinned by a test in the task named.

1. A reference value of 0, or a figure of a few tenths (an API median of 0.1 ms): the difference must not be `NaN` or
   `Infinity`, and must not be "changed" under the absolute floor (Task 4).
2. A scenario or a figure present on one side only, and a reference of another `version`: shown without comparison;
   the version mismatch is refused with a message naming both versions (Task 4).
3. A process that appears or disappears between two `/proc` samples (llama-server starting, a Chromium helper exiting):
   its CPU counts from zero and is never negative (Task 2).
4. A CPU profile with no sample, or only idle samples (a window where nothing ran): totals are 0, not `NaN` (Task 3).
5. A `results.json` of an interrupted run (some scenarios missing, one in `failed`): the report renders, lists what
   failed and why, and shows the rest (Task 5).

---

## File structure

```
scripts/profiling/
  cli.ts              entry of `pnpm profile` and `pnpm profile:report`: options, orchestration, exit code
  options.ts          argv → Options; the scenario table (name, needs, minutes, summary); `--list`
  results.ts          the types of results.json (below) and RESULTS_VERSION
  run-dir.ts          a run's folder: paths, run.json, state.json, results.json read and write
  procs.ts            /proc and sysfs sampling; cpuWindow (pure)            + procs.test.ts
  cdp.ts              minimal CDP client over WebSocket (the Node inspector)
  instance.ts         build and source maps, server, API helper, profile start/stop, undo
  browser.ts          Chromium launch and GPU check, page hooks (React commits, long tasks, paints), census
  measure.ts          one measure window → Window
  scenarios/<name>.ts one file per scenario; scenarios/index.ts exports them in order
  analyze/cpuprofile.ts   summarizeProfile (pure)                          + cpuprofile.test.ts
  analyze/origins.ts      a call frame → module and group, server bundle and client source maps
  analyze/trace.ts        a Chromium trace → TraceSummary
  figures.ts          Results → Figure[]
  compare.ts          NOISE, compare                                        + compare.test.ts
  report/render.ts    renderReport; report/charts.ts, report/style.ts, report/sections/<scenario>.ts
  report/fixture.ts   a small typed Results for the tests                   + report/render.test.ts
```

## Shared types (`results.ts`, created in Task 1)

```ts
export const RESULTS_VERSION = 1;
export const SCENARIO_NAMES = [
  'startup', 'idle', 'load', 'launch', 'dashboard', 'soak', 'aurora',
  'generation', 'chat', 'pages', 'api', 'tps', 'collectors',
] as const;
export type ScenarioName = (typeof SCENARIO_NAMES)[number];

/** Per process group: server, nvml-worker, llama-server, chrome-browser, chrome-renderer, chrome-gpu, chrome-other. */
export interface ProcWindow {
  wallMs: number;
  cpuPct: Record<string, number>; // % of one core
  userPct: Record<string, number>;
  sysPct: Record<string, number>;
  threadPct: Record<string, number>; // `group/thread`, pool threads merged, < 0.05 dropped
  rssMb: Record<string, number>;
  gpuBusyPct: Record<string, number>; // AMD cards, by PCI address
}
export interface PageWindow {
  taskPct: number; scriptPct: number; layoutPct: number; stylePct: number;
  commitsPerSec: number; longTasksMs: number[]; heapUsedMb: number; nodes: number; listeners: number;
}
export interface WsTraffic { seconds: number; byType: Record<string, { count: number; bytes: number }> }
export interface ProfileRow { fn: string; module: string; line: number; group: string; ms: number }
export interface ProfileSummary {
  totalMs: number; activeMs: number; gcMs: number;
  byGroup: { group: string; ms: number }[]; topSelf: ProfileRow[]; topInclusive: ProfileRow[];
}
export interface TraceSummary { framesPerSec: number; mainThreadPct: Record<string, number> }
export interface Census {
  commits: number; totalRenders: number;
  components: { name: string; module: string; renders: number; perCommit: number }[];
}
export interface Window {
  id: string; label: string; profiled: boolean;
  serverUptimeS: number; historyPoints: number;
  procs: ProcWindow;
  eventLoopUtilization: number | null; // null under a profiler (the profiler inflates it)
  page?: PageWindow; ws?: WsTraffic;
  serverProfile?: ProfileSummary; pageProfile?: ProfileSummary; trace?: TraceSummary; census?: Census;
}
export interface PageLoad {
  cache: 'cold' | 'warm';
  ttfbMs: number; fcpMs: number; lcpMs: number; loadMs: number; scriptMs: number; firstSnapshotMs: number;
  requests: number; wireBytes: number; decodedBytes: number;
  byKind: Record<'html' | 'js' | 'css' | 'font' | 'api' | 'other', { count: number; bytes: number }>;
}
export interface ScenarioResults {
  startup: { startMs: number[]; stopMs: number[]; bareNodeMs: number[]; launchProfile: ProfileSummary };
  idle: { windows: Window[] }; // clean, profiled
  load: { loads: PageLoad[] };
  launch: { readyMs: number; logLines: number; windows: Window[] }; // launch
  dashboard: { windows: Window[] }; // clean (60 s), profiled (60 s, census), trace (20 s)
  soak: {
    readings: { t: number; heapMb: number; nodes: number; listeners: number; serverRssMb: number }[];
    serverAfterGc: { start: { rssMb: number; heapMb: number }; end: { rssMb: number; heapMb: number } };
    windows: Window[]; // soak (300 s)
  };
  aurora: { variants: { css: string; window: Window }[] }; // window.id is the variant's id
  generation: { windows: Window[] }; // clean, profiled, trace
  chat: {
    reply: { chars: number; tokens: number; tokensPerSec: number };
    spans: Record<string, { fromChars: number; toChars: number }>; // by window id
    windows: Window[]; // trace, clean, profiled
  };
  pages: { pages: { path: string; load: PageLoad; window: Window; apiCalls: { url: string; ms: number }[] }[] };
  api: { routes: { url: string; firstMs: number; p50Ms: number; p95Ms: number; bytes: number }[] };
  tps: { modes: { id: 'no-page' | 'dashboard' | 'static-page'; tokensPerSec: number[] }[] };
  collectors: {
    nvml: { gpus: number; sampleCpuMs: number; sampleWallMs: number; calls: { call: string; cpuMs: number; wallMs: number }[] } | null;
    reads: { label: string; cpuMs: number; wallMs: number }[];
    skipped: string[];
  };
}
export interface RunInfo {
  name: string; startedAt: string; endedAt: string | null; scenarios: ScenarioName[];
  options: { host: string; port: number; dataDir: string | null; profileId: number | null; chrome: string; build: boolean };
  versions: { app: string; node: string; chromium: string | null; kernel: string };
  machine: { cpu: string; threads: number; memoryGb: number; gpus: string[] };
  profile: { id: number; name: string } | null;
  gpuCompositing: string | null; // Chromium's feature status; anything but 'enabled' is a warning
  symbolicated: boolean; // false with --no-build: page functions keep minified names
}
export interface Results {
  version: typeof RESULTS_VERSION;
  run: RunInfo;
  scenarios: { [K in ScenarioName]?: ScenarioResults[K] };
  failed: { scenario: ScenarioName; error: string }[];
}
```

Aurora variant ids, in order: `as-is`, `no-aurora-animation`, `no-backdrop-blur`, `no-animation-no-blur`,
`no-transition`, `as-is-again`.

---

### Task 1: Scaffold, options and types

**Files:**

- Create: `scripts/profiling/results.ts` (the block above), `scripts/profiling/options.ts`, `scripts/profiling/cli.ts`
- Modify: `pnpm-workspace.yaml` (catalog: `puppeteer-core: ^25.18.1`), `site/package.json` (`"puppeteer-core": "catalog:"`),
  root `package.json` (devDependency `"puppeteer-core": "catalog:"`; scripts `"profile": "node scripts/profiling/cli.ts"`,
  `"profile:report": "node scripts/profiling/cli.ts report"`), `pnpm-lock.yaml` (`pnpm install`)

**Interfaces:**

- Produces:
  - `interface Options { command: 'run' | 'report' | 'list'; scenarios: ScenarioName[]; name: string; compare: string | null; profile: number | null; dataDir: string | null; host: string; port: number; chrome: string; build: boolean }`
  - `class UsageError extends Error`
  - `parseOptions(argv: string[], now: Date): Options` — `all` expands to every scenario; scenarios are returned in
    `SCENARIO_NAMES` order whatever the argument order, without duplicates; the default name is the local date and time
    `YYYY-MM-DD-HHmm`; a leading `--` is dropped (see `site/scripts/argv.ts`); `report <run>` puts the run in `name`.
    Throws `UsageError` for an unknown scenario (the message lists the valid names), no scenario, a name that is not
    `[A-Za-z0-9._-]+`.
  - `SCENARIOS: Record<ScenarioName, { needsModel: boolean; needsBrowser: boolean; minutes: number; summary: string }>`
    with the values of the spec's table (`api`: browser yes, 2 min; `collectors`: model yes).

- [ ] **Step 1:** Create the branch, add the catalog entry and the two `package.json` changes, run `pnpm install`.
      Expected: the lockfile changes only for `puppeteer-core` at the root importer.
- [ ] **Step 2:** Write `results.ts`, `options.ts`, and `cli.ts`: `--list` prints one line per scenario (name, model,
      browser, minutes, summary); a `UsageError` prints `llama-webui profile: <message>` and the usage on stderr and
      exits 2; `run` and `report` print `not implemented yet` and exit 1 for now.
- [ ] **Step 3:** Verify. Run: `pnpm profile --list` → 13 lines. Run: `pnpm profile nope` → exit 2, message naming the
      scenarios. Run: `pnpm lint && pnpm check && pnpm exec vitest run scripts/package.test.ts` → green (the root
      package still has no runtime dependency).
- [ ] **Step 4:** Commit: `chore: Scaffold the profiling tool (options, result types)` (with the spec and this plan).

### Task 2: `/proc` sampling

**Files:**

- Create: `scripts/profiling/procs.ts`, `scripts/profiling/procs.test.ts`

**Interfaces:**

- Produces:
  - `interface ProcSample { t: number; groups: Record<string, { utime: number; stime: number; rssKb: number }>; threads: Record<string, number>; gpuBusy: Record<string, number> }`
    (ticks; `t` in ms)
  - `sampleProcs(roots: { server: number | null; chrome: number | null }): ProcSample` — port `sampleProcs`, `tree` and
    `classify` of `lib.ts`; `chrome-utility` and `chrome-zygote` merge into `chrome-other`; `gpuBusy` reads
    `gpu_busy_percent` of every `/sys/class/drm/card*` whose driver is amdgpu, keyed by PCI address.
  - `cpuWindow(samples: ProcSample[], ticksPerSecond: number): ProcWindow`
  - `watchProcs(roots): { stop(): ProcWindow }` (one sample per second, `getconf CLK_TCK` read once)

- [ ] **Step 1: Write the failing tests**

```ts
const sample = (t: number, groups: Record<string, [utime: number, stime: number]>): ProcSample => ({
  t, threads: {}, gpuBusy: {},
  groups: Object.fromEntries(Object.entries(groups).map(([k, [utime, stime]]) => [k, { utime, stime, rssKb: 2048 }])),
});

test('the CPU of a window is the tick difference over the wall time, as a percentage of one core', () => {
  const w = cpuWindow([sample(0, { server: [100, 50] }), sample(10_000, { server: [150, 100] })], 100);
  expect(w.wallMs).toBe(10_000);
  expect(w.cpuPct.server).toBeCloseTo(10); // 100 ticks = 1 s of CPU over 10 s
  expect(w.userPct.server).toBeCloseTo(5);
  expect(w.sysPct.server).toBeCloseTo(5);
  expect(w.rssMb.server).toBe(2);
});

test('a process that appears counts from zero, one that disappears is not negative', () => {
  const w = cpuWindow(
    [sample(0, { 'chrome-other': [40, 0] }), sample(5000, { 'llama-server': [500, 0] }), sample(10_000, { 'llama-server': [1000, 0] })],
    100,
  );
  expect(w.cpuPct['llama-server']).toBeCloseTo(100);
  expect(w.cpuPct['chrome-other']).toBe(0);
});

test('the GPU gauge is the mean of its readings', () => {
  const a = { ...sample(0, {}), gpuBusy: { '0000:0d:00.0': 40 } };
  const b = { ...sample(1000, {}), gpuBusy: { '0000:0d:00.0': 60 } };
  expect(cpuWindow([a, b], 100).gpuBusyPct['0000:0d:00.0']).toBe(50);
});
```

- [ ] **Step 2:** Run `LLAMA_WEBUI_TEST_BUILD=0 pnpm exec vitest run scripts/profiling/procs.test.ts` → FAIL (no module).
- [ ] **Step 3:** Implement `procs.ts`. A group's CPU is the last cumulative value it reached minus its first, so a
      group absent from the last sample keeps what it used.
- [ ] **Step 4:** Run the test → PASS. `pnpm lint && pnpm check` → green.
- [ ] **Step 5:** Commit: `feat: Sample the CPU of the profiled processes from /proc`.

### Task 3: CPU profile, source maps and trace analysis

**Files:**

- Create: `scripts/profiling/analyze/cpuprofile.ts`, `scripts/profiling/analyze/cpuprofile.test.ts`,
  `scripts/profiling/analyze/origins.ts`, `scripts/profiling/analyze/trace.ts`

**Interfaces:**

- Produces:
  - `interface CallFrame { functionName: string; url: string; lineNumber: number; columnNumber: number }`
  - `interface CpuProfile { nodes: { id: number; callFrame: CallFrame; children?: number[] }[]; samples: number[]; timeDeltas: number[] }`
  - `interface Origin { fn: string; module: string; line: number; group: string }`
  - `parseCpuProfile(json: unknown): CpuProfile` (guards; throws on a file that is not a profile)
  - `summarizeProfile(profile: CpuProfile, originOf: (frame: CallFrame) => Origin): ProfileSummary` — port
    `analyzeProfile` of `analyze.ts`: `(idle)` is excluded from `activeMs`, `(garbage collector)` is `gcMs` and its own
    group, `(program)` its own group; `topSelf` and `topInclusive` hold the 30 largest rows; a recursive function's
    inclusive time is counted once per stack.
  - `serverOrigins(bundlePath: string): (frame: CallFrame) => Origin` and
    `clientOrigins(sourcemapsDir: string | null): (frame: CallFrame) => Origin` — port `serverOrigin`, `clientOrigin`,
    `clientGroup` and the group names of `analyze.ts` (`null`: no map, the minified name and the chunk file are kept).
  - `summarizeTrace(path: string): TraceSummary` — port `analyzeTrace` (frames drawn per second, main-thread share by
    category).

- [ ] **Step 1: Write the failing tests**

```ts
const frame = (functionName: string, url = 'file:///app.js'): CallFrame => ({ functionName, url, lineNumber: 0, columnNumber: 0 });
const origin = (f: CallFrame): Origin => ({ fn: f.functionName, module: f.url, line: f.lineNumber, group: f.functionName.startsWith('(') ? f.functionName : 'app' });
// root → a → b, plus idle and GC; 1 ms per sample
const profile: CpuProfile = {
  nodes: [
    { id: 1, callFrame: frame('(root)'), children: [2, 4, 5] },
    { id: 2, callFrame: frame('a'), children: [3] },
    { id: 3, callFrame: frame('b') },
    { id: 4, callFrame: frame('(idle)') },
    { id: 5, callFrame: frame('(garbage collector)') },
  ],
  samples: [2, 2, 3, 4, 4, 4, 5],
  timeDeltas: [1000, 1000, 1000, 1000, 1000, 1000, 1000],
};

test('self time, inclusive time and groups of a profile', () => {
  const s = summarizeProfile(profile, origin);
  expect(s.totalMs).toBe(7);
  expect(s.activeMs).toBe(4); // a, a, b, GC
  expect(s.gcMs).toBe(1);
  expect(s.topSelf.find((r) => r.fn === 'a')?.ms).toBe(2);
  expect(s.topInclusive.find((r) => r.fn === 'a')?.ms).toBe(3);
  expect(s.byGroup.find((g) => g.group === 'app')?.ms).toBe(3);
});

test('a profile with no sample, or only idle, sums to zero', () => {
  expect(summarizeProfile({ ...profile, samples: [], timeDeltas: [] }, origin)).toMatchObject({ totalMs: 0, activeMs: 0, gcMs: 0 });
  expect(summarizeProfile({ ...profile, samples: [4, 4], timeDeltas: [1000, 1000] }, origin).activeMs).toBe(0);
});
```

- [ ] **Step 2:** Run `…vitest run scripts/profiling/analyze/cpuprofile.test.ts` → FAIL.
- [ ] **Step 3:** Implement the four files.
- [ ] **Step 4:** Run the test → PASS. Check the port on real data:
      `node -e` a three-line script that runs `summarizeProfile` with `serverOrigins` on
      `/home/tristan/DEV/llama-webui/.cache/profiling/2026-11-22/data/E-dash-idle-prof/server.cpuprofile` → `activeMs`
      within 1 ms of `results.json`'s `E-dash-idle-prof.serverProfile.activeMs` (339 ms). `pnpm lint && pnpm check`.
- [ ] **Step 5:** Commit: `feat: Summarize CPU profiles and traces of a profiling run`.

### Task 4: Figures and comparison

**Files:**

- Create: `scripts/profiling/figures.ts`, `scripts/profiling/compare.ts`, `scripts/profiling/compare.test.ts`,
  `scripts/profiling/report/fixture.ts`

**Interfaces:**

- Produces:
  - `type FigureKind = 'cpu' | 'share' | 'tps' | 'duration' | 'size' | 'count' | 'gpuBusy'`
  - `interface Figure { id: string; scenario: ScenarioName; label: string; value: number; kind: FigureKind; profiled: boolean; headline: boolean }`
    — units by kind: % of one core, % of the main thread, tokens/s, ms, bytes, a plain number, %.
  - `figures(results: Results): Figure[]` — one figure per comparable number the report shows. Ids:
    `<scenario>.<window id>.cpu.<group>`, `.user.<group>`, `.sys.<group>`, `.thread.<group/thread>`, `.rss.<group>`,
    `.gpu.<address>`, `.page.<field>`, `.ws.<type>.bytesPerSec`, `.profile.server.activeMs`, `.profile.page.activeMs`,
    `.census.rendersPerCommit`, `.trace.framesPerSec`; then per scenario: `startup.startMs` (median), `startup.stopMs`,
    `load.<cache>.<field>` (median of the loads), `launch.readyMs`, `soak.heapMb.end`, `soak.server.rssAfterGc`,
    `chat.reply.tokensPerSec`, `pages.<path>.<field>`, `api.<url>.p50Ms` / `.p95Ms` / `.bytes`,
    `tps.<mode>.tokensPerSec` (mean), `collectors.nvml.sampleCpuMs`, `collectors.nvml.<call>.cpuMs`,
    `collectors.read.<label>.cpuMs`. `headline` is true for the figures of a non-profiled window's `cpu.*` of
    `server`, `nvml-worker`, `chrome-renderer`, `chrome-gpu`, and for `tps.*`, `startup.startMs`, `load.*.fcpMs`,
    `launch.readyMs`.
  - `NOISE: Record<FigureKind, { relative: number; absolute: number } | null>` with the values of Global Constraints
    (`cpu` and `share`: `{ relative: 0, absolute: 0.5 }`; `gpuBusy`: `null`).
  - `interface Difference { reference: number; delta: number; relative: number | null; changed: boolean }`
    (`relative` is `null` when the reference is 0)
  - `interface Comparison { reference: string; byId: Map<string, Difference>; changed: Figure[]; notes: { scenario: ScenarioName; note: string }[] }`
    — `changed` is sorted by how many times the difference exceeds its threshold, largest first; a note is added for a
    scenario the reference lacks, and for a window whose `serverUptimeS` or `historyPoints` differ by more than a
    factor of two between the two runs.
  - `class VersionMismatch extends Error`; `compare(run: Results, reference: Results): Comparison`
  - `fixtureResults(overrides?): Results` in `report/fixture.ts`: a small typed run with `dashboard` (one clean window,
    one profiled), `tps`, `api` (one route at 0.1 ms) and `startup`.
- A figure is changed when `|delta| > absolute` **and** `|delta| > relative × |reference|`.

- [ ] **Step 1: Write the failing tests**

```ts
const withGpu = (pct: number) => fixtureResults({ cpu: { dashboard: { clean: { 'chrome-gpu': pct } } } });

test('a difference over its threshold is a change, one under it is not', () => {
  const c = compare(withGpu(1.4), withGpu(14.4));
  expect(c.byId.get('dashboard.clean.cpu.chrome-gpu')).toMatchObject({ reference: 14.4, changed: true });
  expect(c.byId.get('dashboard.clean.cpu.chrome-gpu')?.delta).toBeCloseTo(-13);
  expect(c.changed[0]?.id).toBe('dashboard.clean.cpu.chrome-gpu');
  expect(compare(withGpu(14.1), withGpu(14.4)).changed).toEqual([]);
});

test('a tiny duration and a reference of zero are never a change by ratio alone', () => {
  const run = fixtureResults({ apiP50Ms: 0.3 }); // reference fixture: 0.1 ms
  const d = compare(run, fixtureResults()).byId.get('api./api/health.p50Ms');
  expect(d?.changed).toBe(false); // 200 % but 0.2 ms: under the 1 ms floor
  const zero = compare(withGpu(0.2), withGpu(0)).byId.get('dashboard.clean.cpu.chrome-gpu');
  expect(zero).toMatchObject({ relative: null, changed: false });
});

test('a scenario the reference lacks is shown without comparison, with a note', () => {
  const reference = fixtureResults({ without: ['tps'] });
  const c = compare(fixtureResults(), reference);
  expect([...c.byId.keys()].some((id) => id.startsWith('tps.'))).toBe(false);
  expect(c.notes).toContainEqual({ scenario: 'tps', note: expect.stringContaining('not in the reference') });
});

test('a run of another format version is refused', () => {
  const old = { ...fixtureResults(), version: 0 };
  expect(() => compare(fixtureResults(), old as unknown as Results)).toThrow(VersionMismatch);
  expect(() => compare(fixtureResults(), old as unknown as Results)).toThrow(/version 0.*version 1/);
});

test('the GPU gauge is never reported as changed', () => {
  const c = compare(fixtureResults({ gpuBusy: 8 }), fixtureResults({ gpuBusy: 56 }));
  expect(c.changed.some((f) => f.kind === 'gpuBusy')).toBe(false);
});
```

- [ ] **Step 2:** Run `…vitest run scripts/profiling/compare.test.ts` → FAIL.
- [ ] **Step 3:** Implement `report/fixture.ts` (its `overrides` are the ones the tests of Tasks 4 and 5 use),
      `figures.ts`, `compare.ts`.
- [ ] **Step 4:** Run the test → PASS. `pnpm lint && pnpm check`.
- [ ] **Step 5:** Commit: `feat: Compare two profiling runs figure by figure`.

### Task 5: Report

**Files:**

- Create: `scripts/profiling/report/render.ts`, `report/charts.ts`, `report/style.ts`, `report/format.ts`,
  `report/sections/<scenario>.ts` (13), `report/sections/overview.ts`, `report/sections/method.ts`,
  `report/render.test.ts`, `scripts/profiling/run-dir.ts`
- Modify: `scripts/profiling/cli.ts` (the `report` command)

**Interfaces:**

- Consumes: `Results`, `figures`, `compare`, `Comparison`, `fixtureResults`.
- Produces:
  - `renderReport(results: Results, comparison: Comparison | null): string` — one HTML document, no external resource.
  - `runDir(name: string): { path: string; exists(): boolean; file(...parts: string[]): string; readResults(): Results; writeResults(r: Results): void; readState(): State; writeState(s: State): void }`
    with `interface State { serverPid: number | null; chromePid: number | null; conversations: number[]; restoreDefaultProfile: { id: number | null } | null; profileStarted: boolean }`
    (`readResults` validates the top-level shape by guards and returns the version it found for `compare` to refuse).
- The look, the charts (`bars`, `stacked`, `line`), the tooltip script and the CSS tokens are those of
  `/home/tristan/DEV/llama-webui/.cache/profiling/2026-11-22/report.ts`, in English and without its hand-written
  findings. Sections, in order: header (run name, version, date, scenarios, machine; a warning banner when
  `gpuCompositing !== 'enabled'`, a line when `!symbolicated`, the `failed` list with each error), **What changed**
  (comparison only: `changed` as a table of label, reference, value, difference; the notes), overview (stacked CPU of
  `server`, `nvml-worker`, `chrome-renderer`, `chrome-gpu`, one row per non-profiled window), one section per scenario
  present in `results.scenarios` in `SCENARIO_NAMES` order, method (how each kind of figure is taken, the `NOISE` table).
- Every comparable number is printed by one helper, `cell(id)`: the value, and when comparing the reference and the
  signed difference, or `unchanged` under the threshold. A figure with no id in `figures()` is not printed as a number.

- [ ] **Step 1: Write the failing tests**

```ts
test('the report shows the measured scenarios only, with no broken number', () => {
  const html = renderReport(fixtureResults(), null);
  expect(html).not.toMatch(/NaN|undefined|Infinity|\[object/);
  expect(html).toContain('id="dashboard"');
  expect(html).not.toContain('id="chat"');
  expect(html).not.toContain('What changed');
  expect(html).not.toMatch(/(src|href)="https?:/);
});

test('a comparison lists what changed and prints the reference next to a figure', () => {
  const run = fixtureResults({ cpu: { dashboard: { clean: { 'chrome-gpu': 1.4 } } } });
  const reference = fixtureResults({ cpu: { dashboard: { clean: { 'chrome-gpu': 14.4 } } } });
  const html = renderReport(run, compare(run, reference));
  expect(html).toContain('What changed');
  expect(html).toMatch(/14\.4%[\s\S]{0,200}−13\.0/); // en-US percent, U+2212 minus, one decimal
});

test('an interrupted run renders, and says what failed', () => {
  const html = renderReport(fixtureResults({ without: ['tps'], failed: [{ scenario: 'chat', error: 'reply timed out' }] }), null);
  expect(html).toContain('reply timed out');
  expect(html).not.toMatch(/NaN|undefined/);
});

test('software compositing is flagged at the top', () => {
  expect(renderReport(fixtureResults({ gpuCompositing: 'disabled_software' }), null)).toContain('software rendering');
});
```

- [ ] **Step 2:** Run `…vitest run scripts/profiling/report/render.test.ts` → FAIL.
- [ ] **Step 3:** Implement `run-dir.ts` and the report; a section file exports
      `(results, cell) => string | null` and returns `null` when its scenario is absent. Wire `report <run> [--compare <run>]`
      in `cli.ts`: read both `results.json`, write `report.html`, print its absolute path; a missing run or a
      `VersionMismatch` exits 1 with its message.
- [ ] **Step 4:** Run the test → PASS. Write the fixture as a run by hand
      (`.cache/profiling/fixture/results.json`), run `pnpm profile:report fixture`, open the file in headless Chromium
      at 1100 px, light and dark (`emulateMediaFeatures`), read both screenshots: no console error, no overlapping
      label, no horizontal scroll. `pnpm lint && pnpm check`.
- [ ] **Step 5:** Commit: `feat: Render the profiling report, alone and against a reference run`.

### Task 6: Instance, measure window, `startup` and `idle`

**Files:**

- Create: `scripts/profiling/cdp.ts`, `scripts/profiling/instance.ts`, `scripts/profiling/measure.ts`,
  `scripts/profiling/scenarios/index.ts`, `scenarios/startup.ts`, `scenarios/idle.ts`
- Modify: `scripts/profiling/cli.ts` (the `run` command)

**Interfaces:**

- Consumes: `runDir`, `State`, `watchProcs`, `summarizeProfile`, `serverOrigins`, `renderReport`, `compare`.
- Produces:
  - `class Cdp { static connect(wsUrl: string): Promise<Cdp>; send(method: string, params?: object): Promise<unknown>; on(event: string, handler: (params: unknown) => void): void; close(): void }`
    (port of `lib.ts`)
  - `prepareBuild(run, build: boolean): Promise<{ symbolicated: boolean }>` — with `build`:
    `pnpm --dir app exec vite build --sourcemap hidden`, `node build/server.ts` in `app/`, then every `*.map` under
    `app/.output` moved to `<run>/sourcemaps/`; without: `symbolicated: false`, and `UsageError` when
    `app/.output/llama-webui.mjs` is missing.
  - `interface Instance { baseUrl: string; serverPid: number; inspector: Cdp; api(path: string, init?: { method?: string; body?: unknown }): Promise<unknown>; uptimeS(): Promise<number>; historyPoints(): Promise<number>; startProfile(): Promise<{ readyMs: number; logLines: number }>; llamaUrl(): Promise<string>; stop(): Promise<void> }`
  - `startInstance(run, options: Options): Promise<Instance>` — refuses (`UsageError`: `port <port> is in use: stop
    the instance that runs there first`) when the port answers; spawns
    `node --inspect=127.0.0.1:0 app/.output/llama-webui.mjs --host <host> --port <port> [--data-dir <dir>]` detached
    with its output in `<run>/server.log`, reads the inspector URL from its stderr, waits for `/api/health`.
    `startProfile` records the current `defaultProfileId` in `state.json` before `POST /api/server/start`.
  - `undo(run): Promise<string[]>` — from `state.json`, each step tolerant of what is already gone: delete the
    conversations, `POST /api/server/stop`, `PATCH /api/settings` back to the recorded `defaultProfileId` when it
    differs, SIGTERM Chromium, SIGTERM the server and wait for its exit (SIGKILL after 5 s); clears the state as it
    goes; returns one line per thing it undid.
  - `interface WindowOptions { id: string; label: string; ms: number; profile?: boolean; trace?: boolean; ws?: boolean; during?: () => Promise<unknown> }`
  - `measure(ctx: Context, page: Page | null, options: WindowOptions): Promise<Window>` — port `measure` and
    `serverWindow` of `lib.ts`; raw profiles and traces go to `<run>/data/<scenario>/<id>.*`, their summaries into the
    `Window`.
  - `interface Context { run: ReturnType<typeof runDir>; options: Options; instance: Instance; browser: Browser | null; scenario: ScenarioName; log(line: string): void }`
  - `interface Scenario<K extends ScenarioName> { name: K; run(ctx: Context): Promise<ScenarioResults[K]> }`;
    `scenarios/index.ts` exports `SCENARIO_RUNNERS: { [K in ScenarioName]: Scenario<K> }` (the scenarios of later
    tasks throw `not implemented` until their task).
- `cli.ts` `run`, in order: refuse an existing run name; undo any run whose `state.json` is not empty and print what
  was cleaned; when a requested scenario needs a model and neither `--profile` nor the instance's `defaultProfileId`
  gives one, stop with a `UsageError` before anything is built or started (the setting is read from a first, short
  start of the instance only if `--profile` is absent); write `run.json` (the `RunInfo`, rewritten at the end with
  `endedAt`); `prepareBuild`; `startup` first when requested (it launches the server itself, five times, as the
  `startup` step of `run.ts`); `startInstance`; the scenarios without a model; `startProfile` when a remaining one
  needs a model (inside the `launch` scenario when it is requested); the others; `undo`; write `results.json` and
  `report.html` (with `--compare`); print the report's path. A scenario that throws goes to `failed` and the run
  continues; SIGINT and SIGTERM run `undo`, write what was measured, and exit 130.

- [ ] **Step 1:** Implement `cdp.ts`, `instance.ts`, `measure.ts`, the two scenarios (`idle`: a 30 s clean window and a
      20 s profiled one, the `idle` step of `run.ts`) and the `run` command.
- [ ] **Step 2:** Verify, everyday instance stopped. Run: `pnpm profile startup idle --name t6`. Expected: a report
      whose `startup.startMs` median is 100 to 200 ms and whose `idle` clean window gives `server` 1 to 3 % and
      `nvml-worker` 2 to 5 % (first pass: 117 ms, 1.6 %, 3.3 %); `find app/.output -name '*.map'` empty;
      `ss -ltn | grep 7860` empty; `cat .cache/profiling/t6/state.json` empty state.
- [ ] **Step 3:** Verify the undo. Run `pnpm profile idle --name t6-int`, press Ctrl-C after 10 s → exit 130, port
      free, no `llama-webui.mjs` process. Run `pnpm profile idle --name t6-kill` and `kill -9` the CLI after 10 s
      (the server survives), then `pnpm profile idle --name t6-next` → its first line says it stopped the leftover
      server of `t6-kill`, then it runs normally.
- [ ] **Step 4:** `pnpm lint && pnpm check`. Commit: `feat: Run profiling scenarios on a production build`.

### Task 7: Browser, `load`, `launch`, `dashboard`, `soak`, `aurora`

**Files:**

- Create: `scripts/profiling/browser.ts`, `scenarios/load.ts`, `scenarios/launch.ts`, `scenarios/dashboard.ts`,
  `scenarios/soak.ts`, `scenarios/aurora.ts`
- Modify: `scripts/profiling/cli.ts` (start Chromium when a requested scenario needs it), `scenarios/index.ts`

**Interfaces:**

- Consumes: `Context`, `measure`, `clientOrigins`, `summarizeTrace`.
- Produces:
  - `startBrowser(run, chromePath: string): Promise<{ browser: Browser; gpuCompositing: string | null; version: string }>`
    — `puppeteer-core` `launch` with the flags of `CHROME_FLAGS` in `lib.ts` (ANGLE on EGL, GPU enabled), 1920×1080;
    records the pid in `state.json`; reads `SystemInfo.getInfo` and the feature status as `gpucheck.ts` does; prints
    `warning: Chromium is compositing in software, blur costs will be overstated` when it is not `enabled`.
  - `openPage(ctx, path: string, options?: { fresh?: boolean }): Promise<Page>` — a new browser context when `fresh`,
    dark colour scheme emulated, no reduced motion, the init script of `lib.ts` (React commit hook, long tasks, paints,
    LCP); resolves once the page has received its first `/ws` snapshot, then waits a fixed 3 s.
  - `census(page: Page, ms: number): Promise<Census>` (port; names resolved through `clientOrigins`)
  - `loadPage(ctx, path: string, cache: 'cold' | 'warm'): Promise<PageLoad>` (port of the `pageload` step)
- Scenario specifics, each a port of the step named: `load` = `pageload` (three cold, three warm, on `/`);
  `launch` = `launch` (one window with `ws` and a server profile, around `instance.startProfile()`);
  `dashboard` = `page` on `/` (clean 60 s with `ws`, profiled 60 s then a 10 s census, trace 20 s);
  `soak` = `soak` (300 s, a reading every 10 s, `HeapProfiler.collectGarbage` on the page before the first and after the
  last reading; the server's RSS and heap after a forced GC through the inspector at both ends, as `server-gc.ts`);
  `aurora` = `ab` (25 s per variant, the CSS of each variant taken from that step, injected with `addStyleTag` and
  removed after its window).

- [ ] **Step 1:** Implement `browser.ts` and the five scenarios.
- [ ] **Step 2:** Verify. Run: `pnpm profile load launch dashboard aurora --name t7`. Expected, against the first pass:
      cold FCP 100 to 200 ms; ready in 10 to 20 s; `dashboard` clean window `chrome-gpu` 10 to 18 %, `chrome-renderer`
      2 to 5 %, 1 commit/s, page script under 1 %; `aurora` `no-aurora-animation` under 3 % of `chrome-gpu`. The report
      header shows `gpu_compositing: enabled` and page profile rows name `app/src/…` files. After the run: VRAM freed
      (`nvidia-smi`), `defaultProfileId` unchanged (`GET /api/settings` on a restarted instance, or `sqlite3 -readonly`).
- [ ] **Step 3:** Run `pnpm profile soak --name t7-soak` → heap after GC and DOM nodes stable, 300 snapshots.
- [ ] **Step 4:** `pnpm lint && pnpm check`. Commit: `feat: Profile the Dashboard (load, launch, rest, soak, aurora variants)`.

### Task 8: `generation`, `chat`, `tps`

**Files:**

- Create: `scripts/profiling/chat-api.ts`, `scenarios/generation.ts`, `scenarios/chat.ts`, `scenarios/tps.ts`
- Modify: `scenarios/index.ts`

**Interfaces:**

- Consumes: `Context`, `measure`, `openPage`, `census`.
- Produces: `temporaryConversation(ctx): Promise<number>` (title `Profiling (temp)`, thinking off as in
  `newConversation` of `run.ts`, id appended to `state.json` before use); `sendMessage(ctx, id: number, content: string): { done: Promise<void>; stop(): Promise<void> }`.
- `generation` = the `generate` and `stop-reply` steps around three Dashboard windows (clean 30 s, profiled 30 s,
  trace 20 s). `chat` = `chatlong`: the prompt of that step typed in the Chat page's composer; three successive
  windows on the same reply (trace, clean, profiled, then a census), each bounded by the reply's length as in the
  script, `spans` recording the characters at each window's start and end; `reply` read from the stored message's
  stats. `tps` = `tps2` (request, seed and 300 tokens of that step, sent to `instance.llamaUrl()`; six runs per mode,
  the modes interleaved; `static-page` is `/settings`).
- A reply that ends before the last window opens makes the scenario fail with
  `the reply ended after <n> characters, before the <id> window`: it is listed in `failed`, not reported as a figure.

- [ ] **Step 1:** Implement the helper and the three scenarios.
- [ ] **Step 2:** Verify. Run: `pnpm profile generation chat tps --name t8`. Expected: `chat` `chrome-renderer` rising
      across its three windows (first pass: 23, 32, 42 %), Markdown the first group of the page profile; `tps` `no-page`
      within 2 % of 72 tok/s with a spread under 0.5 tok/s; after the run no conversation titled `Profiling (temp)`
      (`sqlite3 -readonly ~/.local/share/llama-webui/llama-webui.sqlite "select count(*) from conversations where title like 'Profiling (temp)%'"` → 0).
- [ ] **Step 3:** Ctrl-C in the middle of `chat` (`pnpm profile chat --name t8-int`) → same checks: no conversation
      left, llama-server stopped, ports free.
- [ ] **Step 4:** `pnpm lint && pnpm check`. Commit: `feat: Profile generation, chat streaming and llama-server throughput`.

### Task 9: `pages`, `api`, `collectors`

**Files:**

- Create: `scenarios/pages.ts`, `scenarios/api.ts`, `scenarios/collectors.ts`
- Modify: `scenarios/index.ts`

**Interfaces:**

- Consumes: `Context`, `measure`, `openPage`, `loadPage`.
- `pages` = the `pages` step: `/`, `/server`, `/system`, `/topology`, `/logs`, `/models`, `/profiles`, `/chat`,
  `/bench`, `/tuning`, `/settings`, each loaded cold in a fresh context (its `PageLoad`, its API calls with their
  duration) then a 12 s clean window whose id is the path.
- `api`: the GET URLs come from the `pages` result of the same run when present, else from one visit of each page;
  each is fetched once (`firstMs`) then 20 times (`p50Ms`, `p95Ms`, `bytes`); URLs sorted, each listed once.
- `collectors`: NVML through `openNvml()` of `app/server/collectors/nvml/symbols.ts` wrapped in a `Proxy` that times
  every function call (`performance.now()` and `process.cpuUsage()`), passed to the app's `deviceHandles` and
  `readNvml` once per second for 11 rounds (the first dropped), per call the mean CPU and wall time summed over the
  cards; `nvml: null` and a `skipped` line when the library does not load. The reads: the list of `fs-reads.ts`
  (per group, `label` as in that script), re-read once per second for 11 rounds; a group whose files do not exist goes
  to `skipped`.

- [ ] **Step 1:** Implement the three scenarios.
- [ ] **Step 2:** Verify. Run: `pnpm profile pages api collectors --name t9`. Expected: eleven pages, `/topology` the
      highest `chrome-renderer`; `api` medians under 3 ms except `/api/topology`; `collectors` lists the five costly
      NVML calls of the first pass first (`MaxClockInfo`, `PcieThroughput` twice, `PowerManagementLimit`, `FanSpeed`)
      and `gpu_busy_percent` of `0000:08:00.0` as the costliest read. `pnpm check` green with the import from
      `app/server/collectors/nvml/`.
- [ ] **Step 3:** `pnpm lint && pnpm check`. Commit: `feat: Profile every page, the API and the collectors' reads`.

### Task 10: Documentation

**Files:**

- Create: `site/content/developers/contributing/profiling.mdx`
- Modify: `site/content/nav.ts`, `site/content/developers/contributing/workflow.mdx` (a row
  `scripts/profiling/` → the new page in "Keep the docs in sync"), `CLAUDE.md` (a short section « Profiling », in
  French)

- [ ] **Step 1:** Write the page (front matter `title`, `description`; no `h1`): what the tool measures and what it
      does not conclude; what it needs (Linux, Chromium, the instance's port free, the GPUs for a scenario with a
      model); the commands; the scenario table (name, model, browser, minutes, what it measures); checking a fix
      (`--name before`, the fix, `--name after --compare before`); reading a comparison (the noise table, the note on
      a run alone against a full pass, profiled windows, the software-rendering warning); where a run lives; what the
      tool undoes. Block components separated from their Markdown by blank lines.
- [ ] **Step 2:** `CLAUDE.md`: the two commands, `scripts/profiling/`, `.cache/profiling/<run>/`, the rule "same
      command before and after a fix", and that no test launches it.
- [ ] **Step 3:** Verify. Run: `pnpm lint && pnpm check && pnpm test`, then `pnpm site:build && pnpm --dir site check-links`
      → green (`site/src/docs/nav.test.ts` covers the nav entry).
- [ ] **Step 4:** Commit: `docs: Document the profiling tool`.

### Task 11: Validation runs and the baseline

- [ ] **Step 1: Noise.** Run `pnpm profile dashboard aurora --name check-1`, then
      `pnpm profile dashboard aurora --name check-2 --compare check-1`. Expected: "What changed" is empty. A figure
      listed there on unchanged code means its threshold is too low: raise that kind in `NOISE`, give the measured
      spread in the comment above it, update the page's table, re-run the comparison. Both reports open in headless
      Chromium, light and dark, with no console error.
- [ ] **Step 2: Full pass, with the user's go-ahead** (GPUs and port 7860 busy for about an hour). Run:
      `pnpm profile all --name baseline`. Expected: no entry in `failed`; scenario by scenario the figures are in the
      order of magnitude of `/home/tristan/DEV/llama-webui/.cache/profiling/2026-11-22/rapport.html` (GPU process at
      rest about 14 %, chat renderer 23 to 42 %, NVML sampler about 3 %, startup about 120 ms, 72 tok/s). Any figure off
      by more than a factor of two is a port bug: find it before going on.
- [ ] **Step 3: Alone against the full pass.** Run `pnpm profile:report check-1 --compare baseline`. Expected: the
      `dashboard` and `aurora` figures agree within the noise. If they do not, add a fixed warm-up to the scenario
      that differs, write the reason in the documentation page, and re-run Steps 1 and 3.
- [ ] **Step 4: Clean state.** `ss -ltn` shows none of 7860 and llama-server's port; no `llama-server`,
      `llama-webui.mjs`, `nvml-worker` or `chromium` process; `nvidia-smi` shows the VRAM released; no
      `Profiling (temp)` conversation; `defaultProfileId` as before the runs; `find app/.output -name '*.map'` empty;
      `git status` clean.
- [ ] **Step 5:** `pnpm lint && pnpm check && pnpm test` green. Commit any threshold change
      (`fix: Calibrate the noise thresholds of the profiling comparison`), then open the PR
      (`feat: Add a profiling tool with before/after reports`), its body ending with
      `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.
