# Nitro spike: S0 probe results

Probe for the six unknowns of the Nitro spike (plan: `~/.claude/plans/on-va-faire-le-floofy-flurry.md`), measured on
2026-11-13 with `nitro@3.0.261103-rc`, Vite 8.3.8 and Node 26.13.0. The probe is this directory: `vite dev`
(`pnpm --filter nitro-probe dev`, port 7870) and `vite build` → `node .output/server/index.mjs`. The scripts that drove
it (HTTP, WebSocket, signals) are in `scripts/`. Verdict: **no hard blocker**. There are two
workarounds to build (reload leak, 405/404) and one degradation (WebSocket payload cap).

## 1. Dev worker, reload, shutdown

- **Where the server runs.** In a **worker thread** of the Vite process (`isMainThread` false, `env-runner`
  `node-worker/worker.mjs`). Its `process.argv` is the worker's (`[node, worker.mjs]`), so the user's `--host`,
  `--port` and `--data-dir` never reach it. Same pid as Vite.
- **Reload.** A save takes 259 ms from the file write to the API answering again. The reload is **scoped**
  (`dev-worker.mjs` `reload(file)`): the changed file and its importers are invalidated and the entry is re-imported,
  in the **same thread and the same `globalThis`** (a `globalThis` counter keeps growing: boots 1, 2, 3…). Modules the
  change does not reach keep their evaluation and their state. Every reload calls the plugins again with a new
  `nitroApp`, but the plugin module itself is not re-evaluated.
- **No cleanup on reload.** Neither the `close` hook, nor `import.meta.hot.dispose` (`import.meta.hot` exists), nor
  `process.on('exit')` runs. After each save the previous instance's child process (`sleep`, standing in for
  llama-server) **keeps running**: one more orphan per save.
  → Workaround: a registry on `globalThis` (`Symbol.for`). Each call of the runtime plugin awaits the previous stack's
  `disposeAsync()` before it builds, and requests wait for `ready()`. This is the same kind of glue #74 removed, but
  much smaller: no module runner of our own and no host server.
- **Dev shutdown.** On a single SIGINT or SIGTERM sent to Vite, the `close` hook runs and is awaited (1.5 s close
  measured), and the child is killed. The worker's own `process.on('SIGINT')` never fires. On **two SIGINTs**, Vite
  exits at once: `close` is cut short and the child is orphaned. In the app, `setpriv --pdeathsig KILL` should cover
  llama-server; to check in S2. pdeathsig follows the thread that spawned the child, here the worker thread.

## 2. WebSocket

- `features.websocket` plus `routes/ws.ts` (`defineWebSocketHandler`): `hello` on open, echo works. The route is
  served on the same port as the dev server, with Vite's HMR alongside it.
- **Refused upgrade.** `throw Response.json({error:'Origin not allowed'},{status:403})` in `upgrade` gives an exact
  `403`, `content-type: application/json`, `connection: close` and the JSON body. That matches today's `wsGuard`.
- **No payload cap.** A 2,000,000-byte frame is accepted. crossws's Node adapter takes `serverOptions.maxPayload`,
  but `nitro/dist/presets/node/runtime/node-server.mjs` (and the dev worker) call `wsAdapter({ resolve })` without
  options, so the limit is `ws`'s default (100 MiB).
  → Options: check the size in `message` and `close(1009)` (the frame is already buffered), or `pnpm patch` Nitro.
- **`/ws` without an upgrade.** `426 text/plain; charset=UTF-8`, `WebSocket upgrade is required.` The golden expects
  `WebSocket upgrade expected` with `text/plain;charset=utf-8`: a small divergence.

## 3. 405 and the SPA renderer

- **The SPA renderer swallows every unmatched `/api/*` request.** `GET /api/only-post` (only a `.post.ts`),
  `PUT`/`DELETE /api/item` (only `.get` and `.patch`), `GET`/`POST /api/nope` and `GET /api` all answer **200 with
  `index.html`**. The native 405 + `Allow` never shows up (the doc's exception for catch-alls applies).
  → Workaround: a middleware on `/api/**` that reuses `allowTable()` (405 + `Allow`, HEAD counted as GET) from a route
  manifest, plus an `/api` catch-all that answers 404 `Unknown route`.
- `HEAD` on a `.get` route: 200 with the GET `content-type` and no `content-length`.

## 4. Builtins

- `node:sqlite` (`DatabaseSync`, SQLite 3.54.0) and `node:ffi` (`dlopen`) work in dev (worker thread) and in the
  production bundle. The build keeps the `node:` prefix: `.output/server/_routes/api/db.mjs` imports `"node:sqlite"`
  and `ffi.mjs` imports `"node:ffi"`. There is no unenv alias.
- The ExperimentalWarning for FFI is printed by the process that imports `node:ffi`. In the app only the forked NVML
  worker does, as today.
- `.output/server` is 216 KiB with a route chunk per file (`_routes/**`, `_libs/**`). `inlineDynamicImports` is not
  tried yet (S6, NVML worker path).

## 5. `errorHandler`

- `defineErrorHandler` receives an h3 `HTTPError` whose **`cause` is the original error** (`HttpError`). The status
  is taken from the original error's `status` field (409). The handler can return `Response.json(...)` with exactly
  today's body: `{"error":"Model in use","code":"model-in-use"}`, `content-type: application/json`.
  → `errorResponse(error.cause ?? error)`.
- A handler that returns a plain object gets `content-type: application/json;charset=UTF-8`. The golden expects
  `application/json`, so the handlers have to return `Response.json(...)`. This is a convention for S3.
- In dev the error is also printed with its stack (`unhandled: true`) even when the handler answered.

## 6. `define`

- `LLAMA_WEBUI_VERSION` from Vite's `define` is replaced in the dev worker and in the production bundle (the literal
  `probe-1.2.3` is in `.output/server/index.mjs`).

## Production (`node_server`)

- Port and host come from `NITRO_PORT`/`NITRO_HOST`. `NITRO_HOST=0.0.0.0` prints "Listening on:
  http://localhost:7872/ (all interfaces)".
- **Shutdown.** SIGINT and SIGTERM both run the `close` hook and **await it to the end**: an 8 s close took 8,038 ms.
  The 5 s graceful timeout only force-closes the open connections ("Graceful shutdown timed out. Forcibly closing
  connections…"). A **second SIGINT** also only force-closes the connections: `close` still finishes and the exit code
  is 0. Nitro waits a fixed ~500 ms after `close`. The `process.on('exit')` handlers run. The app's own `SIGINT`
  handlers are called as well (they log here), so the app must not install its own shutdown.
- **Static files.** Hashed assets get `cache-control: public, max-age=31536000, immutable`, and every other path gets
  the SPA `index.html`.

## Reproduce

- Dev: `pnpm --filter nitro-probe dev`, then `curl --noproxy '*'` on `http://192.168.0.20:7870` (the sandbox's HTTP
  proxy answers 400 otherwise), `node probe-ws.ts`, and save `server/routes/api/item.get.ts` to trigger a reload. The
  probe log goes to `$PROBE_LOG`.
- Signals: a script that starts its own `vite dev` or `node .output/server/index.mjs`, keeps the pid from `$!`, sends
  INT, TERM or INT twice, then checks the log and whether the `sleep` child survived.
