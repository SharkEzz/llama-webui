# Profiling a pull request: `--base` and the `/profiling` comment command

Design approved by the user on 2026-11-23 ("Ça me va, fonce"). Issues: #139 (`--base`), #140 (the command), parent
#108. Calls marked **(my call)** were made while building and were not put to the user.

## Intent

A comment `/profiling` on a pull request measures what the PR changes and answers with the comparison. The user wants
to start it by hand on the PRs where performance matters, and read the result in the PR.

The comparison has to be taken in one go: the machine's state drifts from hour to hour (the NVML cost changed twice in
one night with no code change, #137), so a baseline measured earlier is not a reference.

## Goals

- `pnpm profiling <scenarios> --base <ref>` measures the base then the working tree with the same scenarios, profile,
  address and data directory, and writes the working tree's report compared with the base.
- A workflow runs that command for a `/profiling [scenarios] [--profile N]` comment and answers on the PR.
- A pass never runs next to another llama-server, and never leaves a worktree, a process or a model behind.

## Non-goals

- `--affected` (scenarios picked from the diff): the comment names its scenarios. Second item of #139, left open.
- Deterministic checks on hosted runners (#141) and the nightly pass on `master` (last item of #140).
- Budgets: the command still never fails because a figure is high.
- Installing the runner: it is a service that runs code from GitHub on the user's machine. The docs say how; the user
  does it.

## Anti-goals

- Code from a fork running on the user's machine.
- A comment body reaching a shell.
- Paths or names of the user's machine published on a public repository.

## Approaches

1. **The head's copy of the tool measures both builds** (picked). The base is checked out in a git worktree, installed
   and built; the tool starts each build in turn. A difference is then the app's, never the tool's.
2. **Each side measured by its own copy of the tool** (`node <worktree>/scripts/profiling/cli.ts`, then
   `profiling:report --compare`). Less code, but a PR that touches a scenario would compare two different measures, and
   a base older than an option the pass needs could not run.
3. **Interleave the sides scenario by scenario**, to shrink the drift further. Each scenario would start the server and
   load the model twice more; a full pass is about twenty minutes a side, well under the hour the drift was seen over.

## `--base <ref>`

- **Runs.** The base is an ordinary run named `<name>.base`, the head is `<name>` compared with it. Both can be
  rewritten with `pnpm profiling:report`.
- **The base's sources.** `git worktree add --detach .cache/profiling/<name>.base/src <ref>`, then
  `pnpm install --frozen-lockfile --ignore-scripts --prefer-offline` there (the `prepare` script patches `tsc` and the
  vendored checkout, which a build does not need). The worktree's path is written to the base run's `state.json` before
  it is created; the undo removes it (`git worktree remove --force`), at the end of the command, on a signal, or by the
  next `pnpm profiling` after a kill.
- **Order.** Both sides are built first (a build that fails stops the command before any measure), then the profile to
  launch is read once, then the base is measured, then the head. Base first is also the order a migration needs: the
  head's migrations run after the base has used the data directory.
- **What stays the same on both sides.** The server's working directory is the repository (its `.env` is the one read
  on both sides), the address, the profile, Chromium.
- **The data directory.** Each side runs on its own copy of the data directory (`<run>/datadir`), taken before the
  first measure from the one `--data-dir` names, else the one the server would use (`scripts/profiling/datadir.ts`
  follows the server's rules: `LLAMA_WEBUI_DATA_DIR`, `.env`, `XDG_DATA_HOME`, the home). A copy is written to the
  run's `state.json` before it is made and removed by the undo. Both sides start from the same data, and a migration
  never reaches the source. The copy is taken as the directory is: one the branch already migrated may not open with
  the base's code.
- **`collectors`** imports the app's NVML reader from the sources of the side it measures. When the base's reader does
  not export what the scenario calls, its NVML table is skipped on that side (a note of the scenario, not a failure).
- **Refusals.** `--base` with `--compare` (one reference at a time) or with `--no-build` (the base has no build to
  reuse).
- **`summary.md`.** A run compared with another also writes `summary.md`: the two versions, the figures outside the
  noise (largest excess first, 40 at most), the scenarios that failed on either side and the comparison's notes. It is
  what the command posts.

## A llama-server already running

A scenario with a model needs the GPUs to itself. Before anything is started, the tool refuses when a process named
`llama-server` runs on the machine (exit 2, with its pid). **(my call)**: it applies to every run with a model, not
only under `--base`; with the default port the tool already refused next to a running instance.

## The command

`.github/workflows/profiling.yml`, on `issue_comment` (created):

- **Who and where.** Runs only for a comment on a pull request that is `/profiling` or starts with `/profiling `, from
  an `OWNER`, `MEMBER` or `COLLABORATOR`. A pull request from a fork is refused with an answer **(my call)**: the job
  builds and runs the PR's code on the user's machine, and the code could change between the review and the comment.
- **Runner.** `runs-on: [self-hosted, profiling]`. No other workflow uses that label.
- **The comment's words.** The body goes through an environment variable to `scripts/profiling/comment.ts`, which
  accepts scenario names, `all` and `--profile <integer>`, and nothing else; no scenario means `all`. Anything else is
  answered with the usage.
- **One pass at a time.** `concurrency: profiling`, not cancelled by a newer comment.
- **Data.** The job passes the repository variable `PROFILING_DATA_DIR` (a path on the runner) as `--data-dir` when it
  is set; the tool copies it for each side, as for any `--base` run. The port is the repository variable
  `PROFILING_PORT` (7870 when unset).
- **The answer.** `summary.md` as a comment on the PR, with the measured commit and a link to the workflow run. A pass
  that fails or is refused answers with its reason: the last lines of the output, the runner's home, workspace,
  temporary and data paths replaced.
- **The report.** Copied to `PROFILING_REPORTS_DIR` on the runner when that variable is set. **(my call)**: it is not
  attached to the pull request nor uploaded as an artifact. The repository is public, and the report names the machine
  (CPU, GPUs, kernel, the profile, the data directory's path). The design first shown to the user said the report
  would be attached: this is a deviation, to be reopened if they want it (an artifact is the way, for a private
  repository or once the report can leave the machine's description out).

A workflow started by a comment runs from the default branch: the command cannot be tried before it is merged. What it
calls (`--base`, `comment.ts`, `summary.md`) is tested before.

## Build order

No separate plan document was written: this list was the plan.

1. The side a pass measures (`Target`: sources, build output), through the instance, the scenarios and the build.
2. `--base`: options, the worktree and its undo, the two passes, `summary.md`.
3. The refusal next to a running llama-server.
4. `comment.ts` and the workflow.
5. Docs: the Profiling page (options, a section on `--base`, the command and the runner's setup), `CLAUDE.md`.

## Tests

- Unit: the options, the worktree's and the data copy's undo, the data directory's rules, the llama-server check on a
  fake `/proc`, `summary.md`, the comment parser and the answer.
- By hand, without a model: `pnpm profiling startup idle load --base master` on a free port; SIGTERM during the base's
  build, and SIGKILL then the next command's cleanup. A scenario with a model needs the GPUs: asked of the user.
- The workflow itself: after the merge, by a comment on a PR.
