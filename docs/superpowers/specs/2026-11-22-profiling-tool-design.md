# Profiling tool: design

Decisions marked **(user)** were taken by the user on 2026-11-22; those marked **(call)** are the author's and can be
overturned. The tool exists today as throwaway scripts in `.cache/profiling/2026-11-22/` (`lib.ts`, `run.ts`,
`analyze.ts`, `report.ts` and five one-off measures, about 2,600 lines, untracked): they produced the first report
(`.cache/profiling/2026-11-22/rapport.html`) and are the reference for what each scenario does and how each figure is
computed.

## Intent

A first profiling pass of the app (Dashboard open, llama-server with a model loaded) found six points worth a look: the
animated aurora, the Markdown of a streaming reply, the NVML sampler, the first highlighted code block, the missing
compression, one sysfs read. The user will now fix the important ones, and wants to **run the measures themselves,
before and after each fix**, and read the difference **(user)**.

The scripts become a tool of the repository: one command measures the scenarios it is given and writes a
self-contained HTML report; the report can compare a run with a reference run.

## Goals

- `pnpm profile <scenario…>` measures one or several scenarios on a production build and writes the run (raw data,
  `results.json`, `report.html`) in `.cache/profiling/<run>/` **(user: scenarios by name)**.
- `--compare <run>` shows every figure next to the reference run's, with its difference **(user)**.
- A scenario that verifies one fix runs in a few minutes; the full pass (45 to 60 min) stays possible (`all`).
- The tool leaves the instance as it found it: processes stopped, temporary conversations deleted, settings unchanged,
  `app/.output` identical to a normal build.
- Typed, linted and formatted like the rest of `scripts/`; documented in the developer documentation.

## Non-goals

- **No written conclusions.** The first report's synthesis (cause in the code, possible gain, confidence) was written
  by hand for that run. The tool reports measures and differences; reading them stays a person's job.
- **No budgets, no CI.** The figures depend on the machine (GPU, driver, Chromium): the command never fails because a
  figure is high, and no workflow runs it **(user: option 3 declined)**.
- No support outside Linux (the app's `os` is linux; the tool reads `/proc` and sysfs).
- No change to the app: nothing under `app/` or `packages/` is touched, and no finding is fixed in this lot.
- The 2026-11-22 run is not converted to the new format: the first full pass of the tool becomes the reference.

## Anti-goals

- A measure that changes what it measures without saying so: a figure taken under a profiler is labelled as such, and
  the headline CPU figures always come from windows without a profiler.
- A run that leaves a llama-server, a Chromium, a temporary conversation or a changed setting behind, including after
  Ctrl-C or a failed scenario.
- A report that shows a difference smaller than the noise as a result.

## Constraints

- The server is launched by the tool (`node --inspect=127.0.0.1:<port> app/.output/llama-webui.mjs`): the instance's
  port must be free. An everyday instance running on the same port or data directory is stopped by the user first; the
  tool refuses to start otherwise, with a message that says so.
- A scenario with a model occupies the GPUs of the profile and llama-server's port.
- Chromium must composite on a GPU: headless Chromium falls back to software rendering without the ANGLE/EGL flags of
  the scripts, and software rendering overstates blur costs several times over. The tool reads
  `SystemInfo.getInfo` at launch, records the feature status in the run, and prints a warning (repeated at the top of
  the report) when `gpu_compositing` is not `enabled`.
- `puppeteer-core` is today a devDependency of `site/` only.
- `scripts/` is linted by the root `oxlint.config.ts` (no `any`, no floating promise, type-aware rules) and checked by
  `scripts/tsconfig.json` on `tsconfig.base.json` (`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`).
- Language: the CLI, its messages, the report, the code and its comments are in English, like the rest of the project
  **(call: the first report was in French because it was written for the user alone)**.

## Approaches

1. **Plain port.** One command replays everything and writes the report. Least work; every check costs an hour and two
   reports are compared by eye.
2. **Scenarios by name and comparison.** `pnpm profile [scenario…]`, and a report that shows each figure against a
   reference run. A fix is checked by one scenario in a few minutes. **Chosen (user)**: it is what the fixes need.
3. **Option 2 plus budgets** (the command fails above a threshold). Declined: the figures depend too much on the
   machine for an automatic gate.

## Design

### Commands

```
pnpm profile <scenario…> [--name <run>] [--compare <run>] [--profile <id>] [--data-dir <dir>]
                         [--host <host>] [--port <port>] [--chrome <path>] [--no-build]
pnpm profile --list                         # the scenarios, what each needs, how long it takes
pnpm profile:report <run> [--compare <run>] # rewrite a run's report without measuring
```

- A run's name defaults to the date and time (`2026-11-22-2055`); `--name before-aurora` gives a readable one. A name
  that exists is refused **(call)**. `<run>` is always a folder name under `.cache/profiling/`.
- `--profile` defaults to the instance's `defaultProfileId`; without one and without the option, a scenario that needs
  a model fails before starting anything. Starting a profile makes it the default (`app/server/supervisor/http.ts`):
  the tool reads `defaultProfileId` first and puts it back at the end.
- `--host` defaults to `127.0.0.1`, `--port` to 7860, `--data-dir` to the app's default: the user's real instance
  **(user: real instance, as for the first pass)**. `--chrome` defaults to `/usr/bin/chromium`, like
  `site/scripts/screenshots.ts`.
- The command prints one line per scenario as it starts and ends, and the report's absolute path last.

### Scenarios

Names are the CLI's **(call)**; the letters are the first pass's, to find the matching step in the scripts.

| Scenario     | First pass | Model | Browser | About  | Measures                                                                                                                                                                                                  |
| ------------ | ---------- | ----- | ------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `startup`    | A          | no    | no      | 1 min  | spawn to `/api/health` and SIGTERM to exit, five launches; one CPU profile of a launch                                                                                                                    |
| `idle`       | B          | no    | no      | 1 min  | the server and the NVML sampler with no page: CPU per process and thread, event loop                                                                                                                      |
| `load`       | C          | no    | yes     | 1 min  | Dashboard load, cold and warm cache, three each: TTFB, FCP, LCP, script time, requests, bytes on the wire                                                                                                 |
| `launch`     | D          | yes   | yes     | 1 min  | the profile's start with the Dashboard open: time to ready, log lines, `/ws` messages, server CPU                                                                                                         |
| `dashboard`  | E          | yes   | yes     | 3 min  | Dashboard at rest: a clean window, a profiled window (server and page), a trace, the census of rendered components                                                                                        |
| `soak`       | E, M       | yes   | yes     | 6 min  | Dashboard open five minutes, a reading every 10 s: JS heap after GC, DOM nodes, listeners, `/ws` traffic, server RSS; the server's RSS and heap after a forced GC (inspector) at the start and at the end |
| `aurora`     | K          | yes   | yes     | 3 min  | the Dashboard under six CSS variants (as is, no aurora animation, no backdrop blur, neither, no transition, as is again)                                                                                  |
| `generation` | F          | yes   | yes     | 3 min  | the Dashboard while a reply is generated through the app's chat API                                                                                                                                       |
| `chat`       | G, G2      | yes   | yes     | 4 min  | the Chat page streaming a long Markdown reply: three successive windows (trace, clean, profiled), census, long tasks                                                                                      |
| `pages`      | H          | yes   | yes     | 5 min  | every page loaded cold then watched 12 s                                                                                                                                                                  |
| `api`        | I          | yes   | yes     | 2 min  | every GET the pages make, replayed 20 times: p50, p95, size                                                                                                                                               |
| `tps`        | J          | yes   | yes     | 3 min  | llama-server's own throughput (fixed request and seed, six runs each): no page, Dashboard, a static page                                                                                                  |
| `collectors` | L, N       | yes   | no      | 1 min  | a breakdown, not a verdict: each NVML call and each `/proc` or sysfs read of a monitor tick, timed at the monitor's rate                                                                                  |
| `all`        |            |       |         | 45 min | every scenario above, in this order                                                                                                                                                                       |

- The tool starts what the requested scenarios need, once, in the order above: the build, the server, Chromium when a
  scenario needs a browser, the profile when one needs a model (scenarios without a model run first).
- A window is the common unit, as in the scripts' `measure()`: CPU per process and per thread from `/proc`, RSS, the
  AMD cards' `gpu_busy_percent`, the page's `Performance.getMetrics` deltas, React commits, long tasks, `/ws` frames by
  type, and on request a CPU profile of the server (inspector) and of the page (CDP), a trace, a census.
- The `chat` and `generation` scenarios create conversations titled `Profiling (temp)` and delete them by id.
- `api` takes its URLs from the browser: it opens each page once and records the GETs it makes (the capture of `pages`
  when that scenario ran in the same run), then replays them. Rows are keyed by URL; a URL only one run has is shown
  without comparison.
- `collectors` explains a cost, it does not verify a fix: **a fix of the sampler or of a sysfs read is verified by the
  CPU of the `nvml-worker` process and of the server's threads in `idle` and `dashboard`**, which is what the app
  really spends. For NVML it calls the app's own `readNvml` (`app/server/collectors/nvml/read.ts`, a plain function)
  on the app's `openNvml` symbols wrapped in a timing `Proxy`: the calls timed are the ones the code makes, so a call
  the app stops making disappears from the breakdown. The `/proc` and sysfs reads come from a list kept in the tool,
  written from `app/server/collectors/` and labelled as such in the report (it does not follow the code). It runs with
  the model loaded and the GPUs idle, as in the first pass (llama-server's `fdinfo` reads were the second costliest),
  and skips, with a line in the report, what the machine does not have (no NVML library, no AMD card).
- Every window records the user and system CPU of each process (the first pass read the sampler's split by hand). The
  sampler's own CPU profile (`worker-prof.ts`, through SIGUSR1) is dropped: it attributed every native call to one
  symbol, and the per-call timing replaced it.

### Comparing like with like

A scenario starts from the same state alone or inside `all` as far as the tool controls it: a new browser context, the
same settle time after the page's first snapshot, the same window lengths. What it does not control is how long the
server has run: the monitor's history (300 s, in memory) is almost empty when `dashboard` runs alone and nearly full
inside `all`. In the first pass the Dashboard's figures were the same within the noise with one to two minutes of
history and with five (GPU process 14.3 % and 14.5 %, page script 0.2 % both), so no warm-up is imposed **(call: a
300 s warm-up would defeat the "few minutes" goal)**. Instead:

- every window records the server's uptime and the number of points of the monitor's history at its start, and a
  comparison whose two sides differ by more than a factor of two on either prints a note next to the scenario;
- the documented way to check a fix is the same command before and after it (`pnpm profile aurora --name before`, the
  fix, `pnpm profile aurora --name after --compare before`); `baseline` is the overall picture.

### A run on disk

```
.cache/profiling/<run>/
  run.json        # options, scenarios asked, versions, machine, Chromium's GPU feature status, start and end
  state.json      # what must be undone: pids, conversation ids, the default profile to restore
  data/<scenario>/…   # windows, .cpuprofile files, traces
  sourcemaps/     # the client's maps of this build
  results.json    # the figures of the report, one key per scenario, with a format version
  report.html
```

- `.cache` is already ignored by git, the formatter and the linter.
- `results.json` has a typed shape (`results.ts`) and a `version` number: `--compare` refuses a run of another version
  instead of comparing figures that no longer mean the same thing.
- `profile:report` reads `results.json` only: a report is rewritten without the raw data.

### The build

The page's CPU profile needs source maps to name app code. The tool runs the normal build with hidden source maps
(`vite build --sourcemap hidden`, then `node build/server.ts`), **moves** the `.map` files into the run's `sourcemaps/`
and starts the server from the result: `app/.output` holds the same files as after `pnpm build`, and nothing is rebuilt
at the end **(call; the first pass rebuilt)**. `--no-build` reuses the existing build; page functions then keep their
minified names, and the report says so. The server bundle is not minified and carries a comment per module: it needs
no map.

### Leaving the instance as found

Everything the tool starts or creates is written to `state.json` before use. The end of the command, a failed scenario,
SIGINT and SIGTERM run the same undo: delete the temporary conversations, stop llama-server through the API, restore
`defaultProfileId`, close Chromium, SIGTERM the server and wait for its exit. A run whose `state.json` still lists
something (the tool was killed) is undone by the next `pnpm profile`, before it starts, with a line that says what it
cleaned **(call)**.

### The report

One HTML file, no external resource, light and dark from `prefers-color-scheme`, the look of the first report (inline
SVG bars and lines, values behind `<details>` tables, hover tooltips). It shows only the scenarios the run measured:

- header: version, date, the scenarios, the machine, and the warning when Chromium composited in software;
- overview: CPU per process (server, NVML sampler, page renderer, Chromium's GPU process), one row per measured window;
- one section per scenario, with the figures and tables of the first report's matching section, without its prose
  conclusions (a sentence that only states a figure stays, generated from the data);
- method: how each kind of figure is taken, what was measured under a profiler.

With `--compare <run>`, a first section **What changed** lists the figures whose difference exceeds the noise, largest
first; every headline figure and table cell shows the reference value and the difference; a scenario absent from the
reference is shown without comparison. The noise is a fixed threshold per kind of figure **(call)**, written in one
table of the code and printed in the method section: 0.5 point for a CPU percentage of one process, 1 % for tokens per
second, 10 % for a duration in milliseconds, 5 % for a size. A difference under its threshold is shown as unchanged.

### Where the code goes

`scripts/profiling/` **(call)**: it is a repository tool like `scripts/smoke.ts`, it is covered by `scripts/tsconfig.json`,
the root `oxlint.config.ts` and the `server` Vitest project (`scripts/**/*.test.ts`). The split, for the builder to
adjust: `cli.ts` (the entry of both commands), `options.ts`, `instance.ts` (build, server, profile, undo), `browser.ts`
(Chromium, page hooks), `cdp.ts` (the inspector client), `procs.ts` (`/proc`, sysfs), `measure.ts` (a window),
`scenarios/<name>.ts`, `analyze/` (CPU profiles, source maps, traces), `results.ts`, `compare.ts`, `report/`.

- `puppeteer-core` becomes a root devDependency at the version of `site/`, through a new `catalog:` entry that `site/`
  then uses too **(call: two projects must move together; the scripts resolved it from `site/` by `createRequire`)**. It
  is imported with its types: no `any`.
- Root `package.json`: `"profile": "node scripts/profiling/cli.ts"`, `"profile:report": "node scripts/profiling/cli.ts report"`.

### Tests

Only the hot paths **(user)**, as unit tests in `scripts/profiling/*.test.ts`, none of which starts a server, a model
or a browser:

- CPU profile aggregation (self and inclusive time, grouping by module) on a small hand-written profile;
- CPU percentages from two `/proc` samples;
- the comparison: difference, threshold, a scenario missing from one side, a version mismatch refused;
- the report rendered from a small `results.json`, alone and compared: no `NaN` or `undefined` in the output, only the
  measured scenarios, the "What changed" section.

Scenarios, the instance and the browser are verified by running the tool (below), not by tests.

### Documentation

- A page `site/content/developers/contributing/profiling.mdx` (commands, scenarios, what the tool needs, how to read a
  comparison, the limits), its entry in `site/content/nav.ts`, and a row in the table of "Keep the docs in sync"
  (`workflow.mdx`).
- A short "Profiling" section in `CLAUDE.md` (in French, like the file).

## Verification

- `pnpm lint`, `pnpm check` and `pnpm test` green; `pnpm site:build` and `check-links` for the new page.
- `pnpm profile dashboard aurora --name check-1`, then again as `check-2 --compare check-1`: both reports open in
  headless Chromium with no console error, light and dark; the comparison of two runs of unchanged code shows nothing
  in "What changed" (this is what validates the noise thresholds; a threshold that fails it is raised and the reason
  noted).
- A full pass, `pnpm profile all --name baseline`, with the user's agreement (GPUs and port busy for about an hour):
  its figures match the 2026-11-22 report's in order of magnitude, scenario by scenario; it becomes the reference for
  the fixes.
- `check-1` compared with `baseline`: the `dashboard` and `aurora` figures of a run alone and of the full pass agree
  within the noise; if they do not, the scenario gets a warm-up and the reason is written in the documentation page.
- After each run: ports free, no leftover process, VRAM released, no `Profiling (temp)` conversation,
  `defaultProfileId` unchanged, no `.map` under `app/.output`, `git status` clean.
- Ctrl-C in the middle of `chat`: the same checks hold.

## Left to the builder

- The module split and the internal types.
- Chart details of each report section, within the first report's look.
- The wording of the CLI messages and of the documentation page.
- How a window's options are expressed per scenario.
