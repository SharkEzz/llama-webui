# Node migration — working notes

Companion to [`2026-11-12-node-migration.md`](./2026-11-12-node-migration.md). Three logs, appended to as the port
advances. Nothing here is implemented during the port unless the plan says so.

## Spike findings (N0)

Fill one entry per spike item: what was tried, the measured result, pass/fail against the criterion, and what it
changes in the plan.

| Item | Status | Finding | Impact on the plan |
| --- | --- | --- | --- |
| (a) Dev loop (Vite runner, `/ws` + HMR on one port, globals survive) | open | | |
| (b) NVML on `node:ffi` in a worker | partly answered | Planning probe on Node 26.13.0: real NVML init, driver version, 2 GPUs, name, temperature and shutdown all returned 0 from a `worker_threads` worker; pointers are bigint; `execArgv: ['--disable-warning=ExperimentalWarning']` silences the warning. Still to do: `.ts` worker under native type stripping, 10 min soak, clean `terminate()` | |
| (c) Hono RPC types across web → server (`tsc -b` time, declaration emit) | open | | |
| (d) Build shape (Vite multi-environment vs separate Rolldown; externals vs zero-dependency) | open | | |
| (e) Bun on a pnpm-installed tree | open | | |
| (f) Vitest 5 on Node 26 (`using`, `node:sqlite`, `import.meta.dirname`) | open | | |

## Refactoring and optimisation backlog (for the R milestones, after the merge)

The user asked for refactoring to happen in dedicated milestones after the migration, and for candidates noticed
during the port to be written down here. Add an entry whenever something is spotted; say where, why, and the expected
gain.

| Candidate | Where | Why / expected gain | Noticed |
| --- | --- | --- | --- |
| gzip/brotli and ETag for static assets | prod `web` handler (`server/routes/web.ts`) | ~4.9 MB of assets served uncompressed (largest chunk 972 KiB); HTML has no validator | planning |
| WebSocket backpressure | `server/ws/hub.ts` | `send` return value ignored, no `drain`; a slow client buffers without bound | planning |
| `import.meta.hot.dispose` instead of `__llamaWebuiDispose` | `server/index.ts` | Standard Vite mechanism once the server runs through the module runner | planning |
| Route-level schemas make repo-level `parse` redundant | `server/db/*`, `server/routes/*` | Double validation after N6 | planning |
| `streamSSE` from `hono/streaming` | `server/routes/chat.ts` | Replace the hand-rolled `ReadableStream` SSE | planning |
| Hono v5 | whole server | v5 was at rc during planning; pinned to 4.13.x for the port | planning |
| Erasable syntax + `.ts` import extensions repo-wide | server, shared, web | One rule set with `llamacpp-js`; lets Node run sources natively (25 files with parameter properties, ~620 extensionless imports) | planning |
| Zero-dependency bundle | build config | Smaller install, no registry access at install time; needs licence bundling (N0(d) data) | planning |
| Publish to npm | release pipeline | The package is npm-shaped but unpublished; only the destination changes | planning |
| `server/db/sweeps.test.ts:35` depends on a local `/tmp/lw-j5` file | tests | `test.skipIf` on a developer-machine file: the test never runs in CI | planning |
| `resolve.tsconfigPaths` instead of a duplicated `@` alias | `vite.config.ts` | One source of truth for the alias | planning |
| Stale untracked `shared/` directory at the repo root | repo | Leftover of the move to `packages/webui-shared/`; delete in N13 after the user confirms | planning |

Resolved by the port itself (no action): fonts were base64-inlined into a 568 KB CSS file by Bun's bundler; Vite emits
them as files.

## Contract divergences (N5 onwards)

Differences between the hand-written API reference (`site/content/developers/api/*.mdx`) and the behaviour recorded
in `server/contract/golden.json`. Default policy: fix the docs, keep the behaviour, log it here.

| Route | Docs say | Behaviour is | Resolution |
| --- | --- | --- | --- |
