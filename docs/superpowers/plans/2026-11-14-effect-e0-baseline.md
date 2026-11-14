# Effect POC, E0: Baseline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Record, before any server code changes, the numbers of the Nitro server and the inventory of its tests and
behaviours, so the final report (E10) can compare and count against them.

**Architecture:** Two Node scripts under `scripts/poc/` write JSON files into `docs/superpowers/poc-effect/`: one
measures the repository and its production build, one lists every test. A third file, written by hand from the code,
lists the behaviours each later milestone must bring back. The measuring script is run again unchanged at E10, so it
must not depend on anything Nitro-specific.

**Tech Stack:** Node ≥ 26.13 (scripts run as `node <file>.ts`, erasable syntax, `.ts` import extensions), pnpm,
Vitest 5 (`vitest list --json`), Biome.

**Spec:** `docs/superpowers/specs/2026-11-14-effect-server-design.md` (sections "Milestones", row E0, "Transition" and
"The report (E10)").

## Global Constraints

- Branch `poc/effect`. No file under `app/` or `packages/` changes in this milestone.
- The baseline is taken on a tree whose server code is that of commit `6327201a3` (the commits after it on this
  branch only add documents and these scripts).
- Scripts use `node:*` only, no new dependency; they live in `scripts/poc/` (type-checked by `scripts/tsconfig.json`,
  tests picked up by the Vitest project `server`).
- Code, comments, test names and commits in English. Commits end with
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- `pnpm lint`, `pnpm check` and `pnpm test` green at the end of every task, zero Biome warning. Generated JSON is
  formatted with `pnpm exec biome format --write <file>` before it is committed.
- Never start the app on port 7860 or 7861 (the user's instance and the demo instance): the scripts pick a free port.

## Review Focus

- **Noise in timings:** startup and shutdown are measured 7 times each and the median is kept; the runs are stored so
  a reader can see the spread (Task 1 stores `runs`).
- **A script that only works on Nitro:** the measuring script addresses the build through `app/.output/llama-webui.mjs`,
  `GET /api/health` and `/ws` only, and classifies files by pattern, not by today's folder names (Task 1 test
  `classify`).
- **A reference folder counted as code:** `app/server-legacy/` (created at E1) and `repos/` are never counted (Task 1
  test `classify`).
- **Parameterised tests:** `test.each` cases appear as separate entries in `vitest list`; the inventory keeps them as
  listed and is not deduplicated (Task 2 test).
- **A test file with no milestone:** the inventory fails loudly instead of defaulting (Task 2 test
  `milestoneOf throws on an unmapped file`).

---

### Task 1: Measuring script and baseline numbers

**Files:**

- Create: `scripts/poc/measure.ts`
- Create: `scripts/poc/measure.test.ts`
- Create: `docs/superpowers/poc-effect/baseline.json` (generated)

**Interfaces:**

- Produces (exported from `scripts/poc/measure.ts`, reused at E10):

```ts
export type Group = 'server' | 'serverTests' | 'shared' | 'sharedTests' | 'web' | 'webTests' | 'build';
/** The group a repo-relative path is counted in, or null when it is not counted. */
export function classify(path: string): Group | null;
/** Newline count, as `wc -l`. */
export function countLines(text: string): number;
export function median(values: number[]): number;
/** `owner/repo#123` references in a source text, with their 1-based line. */
export function upstreamRefs(text: string): { line: number; ref: string }[];

export interface Measures {
  commit: string; // `git rev-parse --short HEAD`
  date: string; // ISO 8601
  node: string; // process.version
  code: Record<Group, { files: number; lines: number }>;
  /** `app/src/lib/api.ts` and `app/src/lib/ws.ts`: the web's client layer. */
  webClientLayer: { files: number; lines: number };
  dependencies: {
    app: { dependencies: number; devDependencies: number };
    /** Packages named by `## <name> - <version> (<license>)` headings of the licenses file. */
    bundledIntoServer: string[];
  };
  output: {
    totalBytes: number; // app/.output
    serverBytes: number; // app/.output/server
    clientBytes: number; // app/.output/public
    clientGzipBytes: number; // sum of gzip of each .js and .css under app/.output/public/assets
  };
  startupMs: { runs: number[]; median: number };
  shutdownMs: { runs: number[]; median: number };
  /** Wall time of one run of each command; null with `--skip-durations`. */
  durationsMs: { build: number; check: number; test: number } | null;
  workarounds: { file: string; line: number; ref: string }[];
}
```

Rules `classify` implements (first match wins, paths are repo-relative with `/`):

| Pattern                                                                                | Group                     |
| -------------------------------------------------------------------------------------- | ------------------------- |
| under `repos/`, `app/server-legacy/`, `node_modules/`, `.output/`, or not `.ts`/`.tsx` | `null`                    |
| `app/server/api.gen.ts`                                                                | `null` (generated)        |
| `app/server/**` and (`*.test.ts`, or a `testing/` or `contract/` path segment)         | `serverTests`             |
| `app/server/**`                                                                        | `server`                  |
| `packages/webui-shared/src/**/*.test.ts`                                               | `sharedTests`             |
| `packages/webui-shared/src/**`                                                         | `shared`                  |
| `app/src/components/ui/**`                                                             | `null` (generated shadcn) |
| `app/src/**/*.test.ts(x)`                                                              | `webTests`                |
| `app/src/**`                                                                           | `web`                     |
| `app/build/**`, `app/bin/**`, `app/vite.config.ts`                                     | `build`                   |
| anything else                                                                          | `null`                    |

- [ ] **Step 1: Write the failing tests** in `scripts/poc/measure.test.ts`

```ts
import { expect, test } from 'vitest';
import { classify, countLines, median, upstreamRefs } from './measure.ts';

test('classify sorts paths by pattern, not by folder names of the Nitro server', () => {
  expect(classify('app/server/lib/db/sqlite.ts')).toBe('server');
  expect(classify('app/server/profiles/Profiles.ts')).toBe('server');
  expect(classify('app/server/lib/db/sqlite.test.ts')).toBe('serverTests');
  expect(classify('app/server/lib/testing/launch.ts')).toBe('serverTests');
  expect(classify('app/server/lib/contract/cases.ts')).toBe('serverTests');
  expect(classify('app/server/api.gen.ts')).toBeNull();
  expect(classify('packages/webui-shared/src/profile.ts')).toBe('shared');
  expect(classify('packages/webui-shared/src/profile.test.ts')).toBe('sharedTests');
  expect(classify('app/src/lib/api.ts')).toBe('web');
  expect(classify('app/src/features/chat/Chat.tsx')).toBe('web');
  expect(classify('app/src/lib/api.test.ts')).toBe('webTests');
  expect(classify('app/src/components/ui/button.tsx')).toBeNull();
  expect(classify('app/build/licenses.ts')).toBe('build');
  expect(classify('app/bin/llama-webui.ts')).toBe('build');
  expect(classify('app/vite.config.ts')).toBe('build');
});

test('classify never counts the reference folders', () => {
  expect(classify('app/server-legacy/lib/boot.ts')).toBeNull();
  expect(classify('repos/effect/packages/effect/src/Effect.ts')).toBeNull();
  expect(classify('app/server/lib/contract/golden.json')).toBeNull();
  expect(classify('site/src/root.tsx')).toBeNull();
});

test('countLines counts newlines, as wc -l', () => {
  expect(countLines('')).toBe(0);
  expect(countLines('a\nb\n')).toBe(2);
  expect(countLines('a\nb')).toBe(1);
});

test('median of an odd and of an even number of values', () => {
  expect(median([5, 1, 3])).toBe(3);
  expect(median([4, 1, 3, 2])).toBe(2.5);
});

test('upstreamRefs finds owner/repo#N references with their line', () => {
  expect(upstreamRefs('a\n// see nitrojs/nitro#5133 and h3js/srvx#12\nb')).toEqual([
    { line: 2, ref: 'nitrojs/nitro#5133' },
    { line: 2, ref: 'h3js/srvx#12' },
  ]);
  expect(upstreamRefs('color: #5133; issue #76')).toEqual([]);
});
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `LLAMA_WEBUI_TEST_BUILD=0 pnpm exec vitest run scripts/poc/measure.test.ts`
Expected: FAIL, `./measure.ts` cannot be resolved.

- [ ] **Step 3: Implement the four pure functions** in `scripts/poc/measure.ts`, with the signatures and the table
      above. The module must do nothing when imported: the command-line part of Step 5 runs only under
      `if (import.meta.main)`.

- [ ] **Step 4: Run the tests to make sure they pass**

Run: `LLAMA_WEBUI_TEST_BUILD=0 pnpm exec vitest run scripts/poc/measure.test.ts`
Expected: 5 passed.

- [ ] **Step 5: Implement the command** in the same file:
      `node scripts/poc/measure.ts --out <file.json> [--skip-durations]` (`parseArgs` of `node:util`), which writes a
      `Measures` object as JSON (2 spaces, trailing newline). In this order:
  1. Unless `--skip-durations`: time `pnpm build`, then `pnpm check`, then `pnpm test`, each once, from the repository
     root (`spawnSync`, `stdio: 'inherit'`); a non-zero exit aborts the script. With the flag, `app/.output` must
     already exist, else the script fails with `no build: run pnpm build first`.
  2. `code` and `webClientLayer`: walk the files `git ls-files` returns, `classify` each, read and `countLines`.
  3. `dependencies`: key counts of `app/package.json`; `bundledIntoServer` from the `## ` headings of
     `app/.output/server/THIRD-PARTY-LICENSES.md` (the name is the text before `-`).
  4. `output`: recursive byte sums; gzip with `gzipSync` of `node:zlib`.
  5. `startupMs`, 7 runs: start `process.execPath app/.output/llama-webui.mjs --host 127.0.0.1 --port <free port>
     --data-dir <fresh temp dir>` with `cwd` the temp dir and the environment minus `CI`, `TEST` and `NODE_ENV`
     (as `app/server/lib/testing/launch.ts` does today), poll `GET /api/health` every 10 ms; the run's value is the
     time from spawn to the first 200. A run that has not answered after 30 s fails the script.
  6. `shutdownMs`, on each of those 7 processes once healthy: open a `WebSocket` on `/ws`, wait for its first
     message, send `SIGTERM`; the value is the time from the signal to the process's exit. Remove the temp dir.
  7. `workarounds`: `upstreamRefs` over every file counted in `server` or `build`.

- [ ] **Step 6: Take the baseline**

Run: `node scripts/poc/measure.ts --out docs/superpowers/poc-effect/baseline.json`
then `pnpm exec biome format --write docs/superpowers/poc-effect/baseline.json`.
Expected: the file exists; `code.server.lines` is between 12,000 and 14,000; `dependencies.bundledIntoServer` has 9
names; `startupMs.runs` and `shutdownMs.runs` have 7 values each; `workarounds` names `nitrojs/nitro#5133` and
`nitrojs/nitro#5099`.

- [ ] **Step 7: Check and commit**

Run: `pnpm lint && pnpm check && pnpm test`
Expected: all green.

```bash
git add scripts/poc/measure.ts scripts/poc/measure.test.ts docs/superpowers/poc-effect/baseline.json
git commit -m "chore(poc): Measure the Nitro server as the baseline of the Effect POC"
```

---

### Task 2: Test inventory

**Files:**

- Create: `scripts/poc/inventory.ts`
- Create: `scripts/poc/inventory.test.ts`
- Create: `docs/superpowers/poc-effect/test-inventory.json` (generated)

**Interfaces:**

- Produces:

```ts
export type Milestone = 'E1' | 'E2' | 'E3' | 'E4' | 'E5' | 'E6' | 'E7' | 'E8' | 'keep';
/** The milestone that ports the tests of a repo-relative test file; `keep` when the rewrite does not touch them. */
export function milestoneOf(file: string): Milestone;

export interface InventoryEntry {
  project: string; // Vitest project: server, shared, web, site
  file: string; // repo-relative
  name: string; // full test name as `vitest list` prints it
  milestone: Milestone;
  /** Filled by the milestone that handles the test; absent in the baseline. */
  status?: 'ported' | 'rewritten' | 'dropped';
  /** Repo-relative file of the new test (`ported`, `rewritten`). */
  to?: string;
  /** Why (`dropped`: mandatory). */
  reason?: string;
}
```

`milestoneOf`, first matching prefix (after it, any file that is not matched **throws**
`no milestone for <file>`):

| Milestone | Files                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `E1`      | `app/server/api.gen.test.ts`, `app/server/build.test.ts`, `app/server/dev.test.ts`, `app/server/lifecycle.test.ts`, `app/build/`, `app/server/lib/cli.test.ts`, `app/server/lib/env.test.ts`, `app/server/lib/http.test.ts`, `app/server/lib/proc.test.ts`, `app/server/lib/security.test.ts`, `app/server/lib/version.test.ts`, `app/server/lib/contract/`, `app/server/lib/db/migrations.test.ts`, `app/server/lib/db/settings.test.ts`, `app/server/lib/db/sqlite.test.ts`, `app/src/lib/api.test.ts` |
| `E2`      | `app/server/lib/schemas.test.ts`, `packages/webui-shared/src/profile.test.ts`, `app/src/features/profiles/`                                                                                                                                                                                                                                                                                                                                                                                              |
| `E3`      | `app/server/lib/supervisor/`, `app/server/lib/logs/`, `app/server/lib/llamaFetch.test.ts`, `packages/webui-shared/src/logs.test.ts`, `app/src/lib/props.test.ts`                                                                                                                                                                                                                                                                                                                                         |
| `E4`      | `app/server/lib/collectors/`, `app/server/lib/hardware/`, `app/server/lib/monitor/`, `packages/webui-shared/src/topology.test.ts`                                                                                                                                                                                                                                                                                                                                                                        |
| `E5`      | `app/server/lib/chat/`, `packages/webui-shared/src/chat.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `E6`      | `app/server/lib/models/`, `app/server/lib/hf/`, `packages/webui-shared/src/models.test.ts`, `packages/webui-shared/src/hf.test.ts`                                                                                                                                                                                                                                                                                                                                                                       |
| `E7`      | `app/server/lib/bench/`, `app/server/lib/db/benchRuns.test.ts`, `app/server/lib/db/sweeps.test.ts`, `packages/webui-shared/src/bench.test.ts`, `packages/webui-shared/src/sweep.test.ts`, `app/src/lib/bench.test.ts`                                                                                                                                                                                                                                                                                    |
| `E8`      | `app/server/lib/tuning/`, `app/server/lib/setup.test.ts`, `packages/webui-shared/src/setup.test.ts`, `app/src/lib/tuning.test.ts`                                                                                                                                                                                                                                                                                                                                                                        |
| `keep`    | `scripts/`, `site/`, `packages/webui-shared/src/format.test.ts`, `packages/webui-shared/src/dispose.test.ts`, `app/src/app/`, `app/src/features/topology/`                                                                                                                                                                                                                                                                                                                                               |

`app/server/lib/routes.test.ts` tests route handlers of several domains: `milestoneOf` cannot place it by file, so
the command (Step 3) assigns its entries by test name with this rule, in order: name contains `chat` or `stream` →
`E5`; `bench` → `E7`; `props` → `E3`; `settings` → `E1`; anything else throws.

- [ ] **Step 1: Write the failing tests** in `scripts/poc/inventory.test.ts`

```ts
import { expect, test } from 'vitest';
import { milestoneOf } from './inventory.ts';

test('milestoneOf places a test file in the milestone that ports it', () => {
  expect(milestoneOf('app/server/lifecycle.test.ts')).toBe('E1');
  expect(milestoneOf('app/server/lib/db/migrations.test.ts')).toBe('E1');
  expect(milestoneOf('app/server/lib/schemas.test.ts')).toBe('E2');
  expect(milestoneOf('app/server/lib/supervisor/supervisor.test.ts')).toBe('E3');
  expect(milestoneOf('app/server/lib/llamaFetch.test.ts')).toBe('E3');
  expect(milestoneOf('app/server/lib/collectors/nvml/monitor.test.ts')).toBe('E4');
  expect(milestoneOf('app/server/lib/chat/runs.test.ts')).toBe('E5');
  expect(milestoneOf('app/server/lib/hf/downloader.test.ts')).toBe('E6');
  expect(milestoneOf('app/server/lib/db/sweeps.test.ts')).toBe('E7');
  expect(milestoneOf('app/server/lib/tuning/estimate.test.ts')).toBe('E8');
  expect(milestoneOf('packages/webui-shared/src/format.test.ts')).toBe('keep');
  expect(milestoneOf('app/src/features/topology/layout.test.ts')).toBe('keep');
  expect(milestoneOf('scripts/release.test.ts')).toBe('keep');
});

test('milestoneOf throws on an unmapped file', () => {
  expect(() => milestoneOf('app/server/lib/new/thing.test.ts')).toThrow(
    'no milestone for app/server/lib/new/thing.test.ts',
  );
});
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `LLAMA_WEBUI_TEST_BUILD=0 pnpm exec vitest run scripts/poc/inventory.test.ts`
Expected: FAIL, `./inventory.ts` cannot be resolved.

- [ ] **Step 3: Implement `milestoneOf` and the command** `node scripts/poc/inventory.ts --out <file.json>`: it runs
      `pnpm exec vitest list --json` with `LLAMA_WEBUI_TEST_BUILD=0` (an array of `{ name, file, projectName }`), turns
      each item into an `InventoryEntry` (no `status`), keeps the order of the listing within a file, sorts files by
      path, and writes the array as JSON. Entries are not deduplicated. The command runs only under
      `if (import.meta.main)`. The tests of `packages/llamacpp-js` (`node:test`) are not listed: the package does not
      change.

- [ ] **Step 4: Run the tests to make sure they pass**

Run: `LLAMA_WEBUI_TEST_BUILD=0 pnpm exec vitest run scripts/poc/inventory.test.ts`
Expected: 2 passed.

- [ ] **Step 5: Generate the inventory**

Run: `node scripts/poc/inventory.ts --out docs/superpowers/poc-effect/test-inventory.json`
then `pnpm exec biome format --write docs/superpowers/poc-effect/test-inventory.json`.
Expected: 480 entries plus the tests this plan added (7), every entry with a `milestone`; no throw. If a file
throws, add it to the table of this task (and to `milestoneOf`) in the milestone of the domain it tests, and say so in
the commit message.

- [ ] **Step 6: Check and commit**

Run: `pnpm lint && pnpm check && pnpm test`

```bash
git add scripts/poc/inventory.ts scripts/poc/inventory.test.ts docs/superpowers/poc-effect/test-inventory.json
git commit -m "chore(poc): List every test the Effect rewrite has to account for"
```

---

### Task 3: Behaviour inventory

**Files:**

- Create: `docs/superpowers/poc-effect/behaviours.md`

**Interfaces:**

- Produces: the checklist each later plan (E1 to E8) copies its acceptance list from. One `## E<n>: <name>` section
  per milestone, each with these subsections, every item a `- [ ]` line of one sentence naming the source file it was
  read from:
  - `### Endpoints`: method, path, what it does, its error cases (status and `code`).
  - `### WebSocket messages`: type and when it is sent.
  - `### Startup and shutdown`: what the domain does when the process starts and stops.
  - `### Background work`: timers, watchers, queues, child processes.
  - `### Settings and environment`: variables and settings keys it reads, with defaults.
  - `### Not covered by a test`: behaviours found in the code or in `CLAUDE.md` that no entry of
    `test-inventory.json` exercises.

Endpoints by milestone (69, from `ROUTES` of `app/server/api.gen.ts`; `/ws` belongs to E1):

| Milestone | Endpoints                                                                                            |
| --------- | ---------------------------------------------------------------------------------------------------- |
| E1        | `GET /api/health`, `GET /api/settings`, `PATCH /api/settings`                                        |
| E2        | every `/api/profiles…` (10), `GET /api/flags`                                                        |
| E3        | every `/api/server/…` (6), `GET /api/state`, `GET /api/logs`, `GET /api/launchpad`                   |
| E4        | `GET /api/monitor/history`, `GET /api/monitor/snapshot`, `GET /api/system/info`, `GET /api/topology` |
| E5        | every `/api/chat…` (9)                                                                               |
| E6        | every `/api/models…` (4), `/api/hf/…` (3), `/api/downloads…` (5)                                     |
| E7        | every `/api/bench…` (8), `/api/sweeps…` (7)                                                          |
| E8        | every `/api/tuning/…` (5), `GET /api/setup`                                                          |

WebSocket messages by milestone (`packages/webui-shared/src/ws.ts`): E1 `hello`, `ping`, `pong`; E3 `server-state`,
`log`; E4 `snapshot`, `placement`; E6 `download-progress`, `download`, `download-deleted`; E7 `bench-progress`,
`bench-run`, `bench-deleted`, `sweep-progress`, `sweep`, `sweep-deleted`.

- [ ] **Step 1: Write the E1 section.** Sources to read in full: `CLAUDE.md` (sections "APIs" and "Frontend"),
      `app/server/plugins/runtime.ts`, `app/server/middleware/*.ts`, `app/server/error.ts`, `app/server/routes/ws.ts`,
      `app/server/lib/{boot,context,runtime,cli,env,paths,security,version,http}.ts`, `app/server/lib/ws/hub.ts`,
      `app/server/lib/db/{open,sqlite,migrations,settings}.ts`, `app/bin/llama-webui.ts`, `app/vite.config.ts`,
      `app/build/licenses.ts`, and the four suites `app/server/{lifecycle,build,dev}.test.ts` and
      `app/server/lib/contract/contract.test.ts` (their test names are behaviours). E1 also lists, under "Startup and
      shutdown", the order in which `boot.ts` undoes the runtime, as a numbered list.

- [ ] **Step 2: Write the E2 to E8 sections**, one per milestone, from the route files of the table above
      (`app/server/routes/api/**`), the `app/server/lib/<domain>/` folders they call, and the schemas and types of
      `packages/webui-shared/src/` they use. Every endpoint of the table appears exactly once.

- [ ] **Step 3: Verify the coverage**

Run:

```bash
grep -oE "'(GET|POST|PUT|PATCH|DELETE) /api[^']*'" app/server/api.gen.ts | sort -u | wc -l
grep -cE '^- \[ \] `(GET|POST|PUT|PATCH|DELETE) /api' docs/superpowers/poc-effect/behaviours.md
```

Expected: both print 69. Every message type of `ws.ts` appears in a `### WebSocket messages` subsection
(`grep -c` of each type name is at least 1).

- [ ] **Step 4: Check and commit**

Run: `pnpm lint` (Biome formats Markdown: `pnpm exec biome format --write docs/superpowers/poc-effect/behaviours.md`
first).

```bash
git add docs/superpowers/poc-effect/behaviours.md
git commit -m "docs(poc): List the behaviours each milestone of the Effect rewrite brings back"
```
