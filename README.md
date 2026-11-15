<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/logo-dark.svg">
    <img src="docs/assets/logo-light.svg" alt="llama-webui" width="420">
  </picture>
</p>

<p align="center">
  <strong>A local control room for <a href="https://github.com/ggml-org/llama.cpp">llama.cpp</a>'s <code>llama-server</code>.</strong><br>
  Launch models, watch every GPU in real time, chat, benchmark, and find the best offload settings for your hardware,<br>
  all from one browser tab served by a single Node.js process.
</p>

<p align="center">
  <img alt="Node.js 26" src="https://img.shields.io/badge/Node.js-26-5fa04e?logo=nodedotjs&logoColor=white">
  <img alt="React 19" src="https://img.shields.io/badge/React-19-61dafb?logo=react&logoColor=black">
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-7-3178c6?logo=typescript&logoColor=white">
  <img alt="Tailwind CSS 4" src="https://img.shields.io/badge/Tailwind-4-38bdf8?logo=tailwindcss&logoColor=white">
  <img alt="Linux" src="https://img.shields.io/badge/platform-Linux-fcb442?logo=linux&logoColor=black">
  <a href="LICENSE"><img alt="MIT license" src="https://img.shields.io/badge/license-MIT-44d0c1"></a>
</p>

<p align="center">
  <a href="#features">Features</a> ·
  <a href="#requirements">Requirements</a> ·
  <a href="#installation">Installation</a> ·
  <a href="#configuration">Configuration</a> ·
  <a href="#for-developers">For developers</a>
</p>

<p align="center">
  <img src="docs/assets/screenshots/dashboard.jpg" alt="Dashboard: live generation speed, speculative acceptance, context usage, generation and prompt throughput charts, CPU/RAM/VRAM gauges" width="100%">
</p>

## Why llama-webui?

`llama-server` is fast and flexible, but running it day to day means juggling long command lines, `nvidia-smi` in
another terminal, and a lot of trial and error to fit a big model across several GPUs. llama-webui wraps all of that in
one dashboard designed for a **single machine you own**:

- **One process, one port.** API, WebSocket and UI are served by one Node.js process on port `7860`. No database server:
  everything lives in a SQLite file.
- **Mixed hardware.** NVIDIA (NVML), AMD (sysfs) and CPU are first-class, including multi-GPU setups mixing CUDA and
  Vulkan/ROCm devices.
- **Measured, not guessed.** Throughput, VRAM, PCIe traffic, disk reads and DRAM bandwidth come from the real server and
  the real hardware, and tuning recommendations are validated by actual benchmark runs.

## Features

### 🚀 Server and profiles

- **First-run setup checklist**, then a **launch pad** on Home: every profile with its model, quantization, last
  benchmark and estimated memory fit, started (or switched to) in one click.
- Start, stop, restart or switch `llama-server` in one click; states are tracked live (_starting → ready → stopping_,
  crash detection, externally launched servers detected through `/proc`).
- **Profiles** store a model, an optional multimodal projector, a working directory, `llama-server` arguments and
  environment variables. The argument editor has syntax highlighting, **flag autocompletion and inline help** parsed
  from your own `llama-server --help`.
- Import/export profiles as JSON.
- The server page shows the **effective command line**, `/props` info (quantization, context, slots, modalities,
  llama.cpp build) and the latest logs.
- The child process is tied to llama-webui (`setpriv --pdeathsig`), so it never outlives it.

<table>
  <tr>
    <td width="50%"><img src="docs/assets/screenshots/server.jpg" alt="Server page with status, effective command line and server properties"><p align="center"><sub><b>Server</b>: status, effective command and <code>/props</code></sub></p></td>
    <td width="50%"><img src="docs/assets/screenshots/profiles.jpg" alt="Profile editor with model, projector, arguments and inline flag help"><p align="center"><sub><b>Profiles</b>: editor with inline flag help</sub></p></td>
  </tr>
</table>

### 📈 Live monitoring

- **Dashboard**: generation and prompt tokens/s, speculative-decoding acceptance (draft model or MTP), context usage
  per slot, CPU/RAM/VRAM gauges, model disk reads, and rolling generation and prompt throughput charts, each on its
  own scale.
- **System**: one card per GPU with utilization, VRAM, PCIe link and traffic, power, clocks, temperature and
  fans, plus CPU, memory and disk. NVIDIA through NVML (falls back to `nvidia-smi`), AMD through sysfs.
- **Logs**: 10,000-line live ring buffer with level filter, search and auto-follow.

<p align="center">
  <img src="docs/assets/screenshots/system.jpg" alt="System page with per-GPU utilization, VRAM, PCIe, power, clocks and temperature" width="100%">
</p>

### 🧭 3D hardware topology

The **Topology** page draws your machine as an interactive 3D scene (react-three-fiber): CPU, memory,
NVMe drives, GPUs and chipset, discovered automatically from sysfs. Streaks flow along each link according to
**measured** PCIe, NVMe and DRAM traffic (DRAM through `perf` on AMD Zen 4/5), with the exact throughput next to it
and an alert when a link nears its capacity. GPUs and memory are tanks filled to the memory in use, and cards show the
current phase (loading, prompt, generation) and **how the model is split across devices**, parsed from
`llama-server`'s startup logs.

<p align="center">
  <img src="docs/assets/screenshots/topology.jpg" alt="3D hardware topology with live PCIe, NVMe and DRAM traffic and model placement per device" width="100%">
</p>

### 💬 Chat

- Streaming responses with Markdown, GFM tables and syntax-highlighted code blocks (Shiki) with copy buttons.
- Collapsible reasoning for thinking models.
- Per-conversation sampling settings and system prompt, stop and regenerate.
- **Stats under every answer**: time to first token, prompt and generation speed, token count, MTP/draft acceptance.
- Conversations are persisted in SQLite and generation keeps running server-side if you leave the page.

<p align="center">
  <img src="docs/assets/screenshots/chat.jpg" alt="Chat with highlighted code and per-message statistics" width="100%">
</p>

### 📦 Models

Recursive scan of your models folder with GGUF header metadata: architecture, quantization, size, parameters, layers,
context length and experts (MoE). Split (sharded) models and multimodal projectors are recognized.

Download GGUF models from **Hugging Face** without leaving the app: search the Hub (or paste a repo id or URL), pick a
quantization (shards are grouped, a matching `mmproj` is offered, a badge tells whether it fits in your VRAM) and it lands
in `<models folder>/<org>/<repo>/`. One download at a time, with live progress, sha256 verification, a free-space check,
and automatic resume after a network error or a restart.

<p align="center">
  <img src="docs/assets/screenshots/models.jpg" alt="Models table with architecture, quantization, size, parameters, layers, context and experts" width="100%">
</p>

### ⏱️ Benchmark

- Run **`llama-bench`** (raw llama.cpp speed) or a **real `llama-server`** run (warm-up plus measured completions,
  speculative decoding and the profile's context included, peak VRAM recorded).
- Start from a model and flags or from an existing profile: `-ngl`, `-ncmoe`, `-dev`/`-ts`, `-sm`, `-fa`, `-ctk`/`-ctv`,
  `-ot`, threads, batch sizes…
- Live progress, a filterable history, **side-by-side comparison** with differences highlighted, and **turn any run into
  a profile**.

<p align="center">
  <img src="docs/assets/screenshots/benchmark.jpg" alt="Benchmark history with prompt and generation speed, MTP acceptance and peak VRAM" width="100%">
</p>

### 🪄 Tuning and sweeps

- Detects your GPUs, RAM and CPU and **recommends a full set of flags** for a goal: _responsive chat_, _agent & RAG_,
  _max context_, _make the model fit_, or _100 GB model_ (MoE experts in RAM, attention and norms on every GPU).
- Every recommended flag comes with **why**, and a per-device VRAM/RAM estimate tells you what fits, what spills, and
  how much NVMe bandwidth an `mmap` overflow will cost per generated token.
- **Sweeps** explore a search space you define (values per flag, devices, `--override-tensor` patterns): the cartesian
  product is filtered by the estimator, run sequentially with `llama-bench` (resumable after a restart), ranked, and the
  best candidates are **validated with a real server** before becoming a profile.
- A read-only **system checks** panel (NVIDIA persistence mode and power limit, PCIe link, ReBAR, AMD DPM, CPU governor,
  THP, memlock, swappiness, IOMMU, disk speed…) with the command to fix each item.

<p align="center">
  <img src="docs/assets/screenshots/tuning.jpg" alt="Tuning recommendation table with per-device VRAM and RAM estimates" width="100%">
</p>

### 🎨 Polished UI

Light and dark themes (or follow the system), a refined glass look, and real-time updates over a single WebSocket that
reconnects on its own.

<p align="center">
  <img src="docs/assets/screenshots/dashboard-light.jpg" alt="Dashboard in light theme" width="100%">
</p>

## Requirements

| Requirement                                                                      | Notes                                                                                                                                                |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Linux**                                                                        | Hardware discovery and telemetry read `/proc` and `/sys`. `setpriv` (util-linux) is used to tie `llama-server` to llama-webui.                       |
| **[Node.js](https://nodejs.org) ≥ 26.13**                                        | The runtime. npm, which comes with it, installs a release; [pnpm](https://pnpm.io) 12 runs it from source.                                           |
| **[llama.cpp](https://github.com/ggml-org/llama.cpp)** build with `llama-server` | Any backend (CUDA, Vulkan, ROCm, CPU…). Put `llama-bench` next to `llama-server` to enable benchmarks and sweeps.                                    |
| GGUF models                                                                      | In a folder of your choice (set it in Settings).                                                                                                     |
| _Optional_: NVIDIA driver                                                        | GPU telemetry through NVML, falling back to `nvidia-smi`.                                                                                            |
| _Optional_: `amdgpu` driver                                                      | AMD GPU telemetry through sysfs.                                                                                                                     |
| _Optional_: `perf`                                                               | DRAM bandwidth on AMD Zen 4/5. Needs `kernel.perf_event_paranoid ≤ 0` or `setcap cap_perfmon=ep` on `perf`; otherwise CPU activity is shown instead. |

## Installation

Each [release](https://github.com/SharkEzz/llama-webui/releases) is an npm package, `llama-webui-<version>.tgz`, with
the SHA-256 of its files in `SHA256SUMS`. Install it with the npm of Node.js 26.13 or later:

```bash
VERSION=x.y.z   # the latest release
BASE=https://github.com/SharkEzz/llama-webui/releases/download/v$VERSION
curl -fL -O "$BASE/llama-webui-$VERSION.tgz" -O "$BASE/SHA256SUMS"
sha256sum -c SHA256SUMS
npm install -g "./llama-webui-$VERSION.tgz"
llama-webui
```

Or run it from source (needs pnpm):

```bash
git clone https://github.com/SharkEzz/llama-webui.git
cd llama-webui
pnpm install
pnpm start
```

Then open **<http://127.0.0.1:7860>**. The status bar shows the running version: the release tag or commit hash of the
build, `dev` in development. The [installation guide](https://sharkezz.github.io/llama-webui/docs/getting-started/installation/)
also covers the npm prefix, a systemd service, updates and uninstalling.

On first launch, Home opens a **setup checklist**: it finds your `llama-server` binary (or asks for its path), checks
the models folder, lists what `llama-bench` and the GPU telemetry can see, and reviews the machine configuration with
the exact commands to run. Only the binary and the models folder are required; you can reopen the checklist later from
**Settings**. Once it is done, Home becomes a **launch pad**: one card per profile, with its model, last benchmark and
memory fit, started in one click.

> [!TIP]
> Not sure which flags to use? Open **Tuning**, pick your model and a goal, and click _Create profile_ from the
> recommendation, or _Run a benchmark_ to measure it first.

## Configuration

Launch options can be passed as flags or environment variables (a flag wins over its variable). `llama-webui --help`
(or `pnpm start --help`) lists them.

| Flag                | Environment variable   | Default                                                         |
| ------------------- | ---------------------- | --------------------------------------------------------------- |
| `--host <address>`  | `LLAMA_WEBUI_HOST`     | `127.0.0.1` (`0.0.0.0` opens it to the LAN)                     |
| `--port <port>`     | `LLAMA_WEBUI_PORT`     | `7860`                                                          |
| `--data-dir <path>` | `LLAMA_WEBUI_DATA_DIR` | `$XDG_DATA_HOME/llama-webui`, else `~/.local/share/llama-webui` |

```bash
llama-webui --host 0.0.0.0 --port 8080   # from source: pnpm start --host 0.0.0.0 --port 8080
```

Hugging Face downloads use the same token as the `hf` CLI: `HF_TOKEN` if set, otherwise the token saved by
`hf auth login` (`~/.cache/huggingface/token`, or `$HF_HOME/token`). It is only needed for gated or private repos (and
gives higher rate limits); llama-webui never stores it. `HF_ENDPOINT` points to a mirror.

Everything else (binary path, default `llama-server` host and port, models folder, polling interval, history length,
hidden GPUs, collectors, theme) is set from the **Settings** page and stored in the SQLite database inside the data
directory, along with profiles, conversations, benchmark runs and sweeps.

> [!WARNING]
> llama-webui has **no authentication**: whoever can reach it can start processes on your machine. It listens on
> `127.0.0.1` by default. The API rejects cross-site requests and DNS-rebinding attempts, but only use `--host 0.0.0.0`
> on a network you trust, and never expose it to the internet.

## For developers

> [!NOTE]
> This is the short version. The full developer documentation is on the website:
> [sharkezz.github.io/llama-webui/developers](https://sharkezz.github.io/llama-webui/developers/).

### Getting started

```bash
pnpm install       # the whole workspace (site/ included), one pnpm-lock.yaml
pnpm dev           # vite dev in app/: UI with HMR, the server in Nitro's dev worker, one port
pnpm start         # vite build, then node app/.output/llama-webui.mjs
pnpm check         # type check every package (tsc), in parallel
pnpm test          # Vitest, then the llamacpp-js tests (node --test)
pnpm lint          # Biome: format + lint + import order (read-only)
pnpm lint:fix      # apply Biome's safe fixes
node scripts/smoke.ts --tarball   # pack, npm install into an empty prefix, smoke-test the installed command
pnpm release 0.2.0 # set every package.json version, merge, then tag v0.2.0
```

### Architecture

llama-webui is **one Node.js process** that serves the UI, a REST API and a WebSocket, and drives `llama-server` as a
child process.

```mermaid
flowchart LR
  subgraph browser["Browser"]
    ui["React SPA"]
  end
  subgraph node["Node.js process :7860"]
    routes["Routes /api/*"]
    hub["WsHub /ws"]
    sup["Supervisor"]
    mon["Monitor"]
    chat["ChatRuns"]
    bench["BenchRunner"]
    db[("SQLite")]
  end
  ui -- "REST, chat over SSE" --> routes
  hub -- "snapshots, logs, states" --> ui
  routes --- db
  sup -- "spawn" --> ls["llama-server"]
  chat -- "/v1/chat/completions" --> ls
  mon -- "/metrics, /slots" --> ls
  mon -- "NVML, sysfs, /proc, perf" --> hw["GPUs, CPU, RAM, disks"]
  bench -- "spawn" --> lb["llama-bench"]
```

| Piece                                                  | Role                                                                                                                                                                                                                                                                                               |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `app/server/` (Nitro)                                  | The Nitro server: one file per API route in `routes/api/`, `/ws` in `routes/ws.ts`, the middlewares in `middleware/`, and `plugins/runtime.ts`, which starts the runtime of `lib/boot.ts` (opens SQLite, builds the services below, wires their events to the WebSocket).                          |
| **Supervisor** (`app/server/lib/supervisor/`)          | Owns the single managed `llama-server`: builds its argv from a profile (adding `--host`, `--port`, `--metrics`, `--slots`, `--props`), tracks its state (`idle`, `starting`, `ready`, `stopping`, `crashed`, or `external` for a server it did not launch) and pipes its output into the log ring. |
| **Monitor** (`app/server/lib/monitor/`, `collectors/`) | Polls every collector once per tick (1 s by default) and merges the results into a `Snapshot`: `llama-server` `/metrics` and `/slots`, NVML through `node:ffi` in a child process (`nvidia-smi` as a fallback), AMD sysfs, `/proc`, disks and `perf`. History is kept in RAM only.                 |
| **WsHub** (`app/server/lib/ws/`)                       | Pushes typed messages (`WsMessage` in `packages/webui-shared/src/ws.ts`): `snapshot`, `log`, `server-state`, `placement`, `bench-*`, `sweep-*`. The client reconnects with backoff and re-reads the current state over REST.                                                                       |
| **ChatRuns** (`app/server/lib/chat/`)                  | Relays the OpenAI-compatible stream of `llama-server` as SSE and persists messages and stats. A generation is owned by the server, not by the HTTP request: leaving the page does not stop it.                                                                                                     |
| **BenchRunner** (`app/server/lib/bench/`)              | Runs one benchmark at a time (`llama-bench -o json` or a temporary `llama-server`). The **bench gate** stops the managed server for the duration and restarts it afterwards. Sweeps are a queue stored in SQLite, resumed on startup.                                                              |
| **Tuning** (`app/server/lib/tuning/`)                  | Memory estimator (GGUF header + devices), presets, sweep search space and system checks.                                                                                                                                                                                                           |
| **SQLite** (`app/server/lib/db/`)                      | `node:sqlite`, migrations in `migrations.ts`, one repository per table: settings, profiles, conversations, benchmark runs, sweeps. Metrics and logs are never persisted.                                                                                                                           |
| `packages/webui-shared/`                               | Types, zod schemas and pure functions (parsers, phase) used by both sides.                                                                                                                                                                                                                         |
| `packages/llamacpp-js/`                                | The llama.cpp client: `llama-server` HTTP API, metrics, `--help` flags, `llama-bench` output. No app dependency, Node ≥ 24, tree-shakeable.                                                                                                                                                        |
| `app/src/`                                             | React 19 SPA. One folder per page in `features/`, lazy-loaded by the router; the typed API client (`lib/api.ts`, typed by the generated `app/server/api.gen.ts`) and zustand stores per domain in `lib/`; shared glass components in `components/glass/`.                                          |

Every `/api/*` route goes through the middlewares of `app/server/middleware/`: startup wait, the guard of
`lib/security.ts` (Host header, Origin, JSON-only writes) and the `405` table; `app/server/error.ts` turns errors into
JSON responses.

### Dev vs production

- `pnpm dev` is `vite dev` in `app/`: HMR for the UI, the server in Nitro's dev worker, re-evaluated on each save.
  It takes no flags: `LLAMA_WEBUI_*` variables, or the `.env*` files of `app/`.
- `pnpm build` (`vite build` in `app/`) writes `app/.output/`: the UI split per page in `public/`, the self-contained
  server in `server/` (it imports only `node:*`) with the NVML sampler next to it, and the launcher `llama-webui.mjs`
  (`.env`, the CLI flags). `pnpm start` builds, then runs it; it reports `git describe` as its version (`dev` in
  development).
- A release is the npm package of the root (`bin` `llama-webui`, `files` `app/.output`, no dependencies).
  `.github/workflows/release.yml` builds, packs, smoke-tests the installed tarball and attaches it with its
  `SHA256SUMS` to the release of every `v*` tag, which must match the version of every `package.json`
  (`pnpm release <version>`, merged first).

> [!IMPORTANT]
> **Development reloads.** A saved route file keeps the runtime and `llama-server`. Saved business code (under
> `app/server/lib/`) rebuilds the runtime and stops `llama-server`, as any shutdown does: a running sweep becomes
> interrupted (Resume continues it) and a chat reply is saved as stopped. A start that fails waits for the next save.

### Conventions

- Code comments, UI strings, commit messages and pull requests are in **English**.
- Before committing or opening a PR, `pnpm lint`, `pnpm check` and `pnpm test` must all pass, with zero Biome
  errors or warnings. Do not disable or downgrade a rule; use a targeted `// biome-ignore` with a reason for a genuine
  false positive.
- `app/src/components/ui/` is generated by shadcn and left untouched (ignored by Biome).
- Tests cover pure logic (parsers, estimator, sweep space…) with real captured outputs in `testdata/`.

### Tech stack

[Node.js](https://nodejs.org) 26 (`node:sqlite`, `node:ffi`) · [pnpm](https://pnpm.io) · [Vite](https://vite.dev) · [Nitro](https://nitro.build) ([h3](https://h3.dev), srvx, crossws) · [Vitest](https://vitest.dev) ·
[React 19](https://react.dev) · [React Router](https://reactrouter.com) · [Tailwind CSS 4](https://tailwindcss.com) ·
[shadcn/ui](https://ui.shadcn.com) on [Base UI](https://base-ui.com) · [uPlot](https://github.com/leeoniya/uPlot) ·
[react-three-fiber](https://r3f.docs.pmnd.rs) · [Shiki](https://shiki.style) · [Zustand](https://zustand.docs.pmnd.rs) ·
[Zod](https://zod.dev) · [Biome](https://biomejs.dev)

## License

[MIT](LICENSE) © SharkEzz
