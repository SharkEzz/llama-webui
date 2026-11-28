# Effect POC: the report

The Nitro server (h3, zod, `app/server/` until `2856a9e0e`) was ported to an Effect server, milestone by milestone
(E1 to E9, `docs/superpowers/plans/2026-11-1[45]-effect-*.md`), behind the same web client and the same data
directory. This report gives the measures the spec asks for (`docs/superpowers/specs/2026-11-14-effect-server-design.md`,
"The report (E10)"), what the port changed, and what a merge would take.

**Before** is `13068280e` (the end of E0: the Nitro server, the Effect packages already installed, the shared package
checked by the Effect diagnostics). **After** is `74d0f4dd7` (the end of E9). Both were built and measured back to back
on the same machine, the same day, on Node v26.13.1, by `scripts/poc/measure.ts`: `baseline-e10.json` and `e10.json`
in this folder. Lines are the newlines of each file, blank lines and comments included, counted by the same script.

## Code

| Part                                               | Before: files / lines | After: files / lines |
| -------------------------------------------------- | --------------------- | -------------------- |
| Server (`app/server/`, tests aside)                | 166 / 12300           | 121 / 16608          |
| Server tests                                       | 59 / 7256             | 121 / 24247          |
| Shared (`packages/webui-shared/src/`, tests aside) | 18 / 1835             | 37 / 3636            |
| Shared tests                                       | 11 / 608              | 22 / 1454            |
| Web (`app/src/`, tests aside)                      | 128 / 14325           | 131 / 14533          |
| Web tests                                          | 12 / 1031             | 17 / 1979            |
| Web client layer (`lib/api.ts` and what it calls)  | 2 / 225               | 2 / 235              |
| Build code (`app/build/`)                          | 5 / 321               | 6 / 343              |

- The server grew by 35 % (4300 lines) and the shared package doubled. The definition of the API moved into the shared
  package (`src/api/`: one group per domain, its endpoints and their errors as schemas), so part of the shared growth
  is the server's: the routes of the Nitro server held their own validation, the Effect server reads it from `Api`.
  The rest is the Schema form of the shapes zod held (`Schema.Struct`, `Schema.TaggedError`, a branded class each) and
  the explicit services and layers (a `Context.Service` per domain, its `layer` and `layerWith`).
- The server's tests more than tripled (7256 to 24247 lines). Each milestone wrote down the behaviour it ported
  (`behaviours.md`, 780 lines) and tested it, including what the Nitro server had no test for; the contract suite
  (`app/server/contract/`) replays every endpoint over real HTTP against the build.
- The web is nearly unchanged (+208 lines): the client is derived from `Api` (`call`, `callStream`) instead of the
  route table generated from Nitro (`api.gen.ts`, gone), and the error checks read `_tag` instead of a status.

## Dependencies

- `app/package.json`: 30 dependencies and 11 dev dependencies before, 29 and 10 after: `nitro` and `zod` went.
  `effect`, `@effect/platform-node`, `@effect/sql-sqlite-node` and `@effect/vitest` were already there at E0.
- Bundled into the server, before: `@huggingface/gguf`, `@huggingface/tasks`, `crossws`, `h3`, `nitro`, `rou3`,
  `srvx`, `zod`. After: `@effect/platform-node`, `@effect/platform-node-shared`, `@effect/sql-sqlite-node`,
  `@huggingface/gguf`, `@huggingface/tasks`, `effect`, `ws`. The built server still imports nothing but `node:*`
  (`app/server/build.test.ts`), and the published package still has no dependency.

## Sizes

| Output                                  | Before               | After                 |
| --------------------------------------- | -------------------- | --------------------- |
| `app/.output`                           | 6049147 B            | 8066188 B (+33 %)     |
| Server bundle (`server/index.mjs` etc.) | 1150561 B            | 3043380 B (×2.6)      |
| Web client (`public/`), raw / gzip      | 4891907 B / 993568 B | 5022748 B / 1038186 B |

The server bundle is not minified (stack traces stay readable): Effect's runtime, Schema, the HTTP and SQL modules
and the CLI weigh 1.9 MB more than h3, srvx, rou3 and zod. The client grew by 4.5 % (gzip): it now carries Schema and
the `HttpApiClient` to decode replies, where it used to cast them.

## Time

| Measure (median of 7)                           | Before   | After    |
| ----------------------------------------------- | -------- | -------- |
| Launch to the first `200` of `/api/health`      | 103 ms   | 116 ms   |
| Shutdown with a page open (SIGTERM to the exit) | 1005 ms  | 9 ms     |
| `pnpm build`                                    | 660 ms   | 969 ms   |
| `pnpm check`                                    | 1201 ms  | 2095 ms  |
| `pnpm test`                                     | 11461 ms | 20575 ms |

- Startup costs 13 ms more (the bigger bundle to load); there is still no "starting" window, the port opens once every
  service is built.
- Shutdown with a page open went from a second to 9 ms. Both close the page's WebSocket with 1001 and give a client
  that never answers 500 ms; the Nitro server then went through Nitro's and srvx's close of the HTTP server, which held
  the process about a second (measured, not traced further), where the Effect server runs its shutdown steps, closes
  the HTTP server and undoes its layers.
- `pnpm check` takes 0.9 s more: the Effect language service runs inside `tsc` on the server and the shared package.
- `pnpm test` takes 9 s more for twice the tests (480 before, 979 after), the contract suite and the black-box suites
  against the build included.

## Tests

The inventory of E0 (`test-inventory.json`, 487 tests: server 338, web 56, shared 47, site 46) says what became of
each test:

- **104 kept** as they were (the site, the web tests that did not touch the API, `llamacpp-js`);
- **276 ported** (the same assertion on the Effect code), **81 rewritten** (the same behaviour, tested another way: a
  layer instead of a module mock, the TestClock instead of real waits, the contract instead of a route test);
- **26 dropped**, each with its reason:

| Tests                                                                                                                               | Reason                                                                                                                                                                                                             |
| ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `api.gen.test.ts` (3): the generated route map, its methods, its update in dev                                                      | The generator is gone: the client is derived from the `HttpApi` definition of `@llama-webui/shared`.                                                                                                               |
| `sqlite.test.ts` (7): the wrapper's `get`/`all`/`run`/`exec`, transactions and savepoints                                           | The wrapper is gone: the database is the `SqlClient` of `@effect/sql-sqlite-node` (`SqlClient.withTransaction`).                                                                                                   |
| `http.test.ts` (7): `appError`, the 405 with `Allow`, an empty `:param`, `idParam`, `readJson`, a handler's content type, `queryOf` | h3 helpers: `HttpApi` decodes paths, payloads and queries from the API definition. No 405: a wrong method is a 404 `RouteNotFound`; a trailing slash is a 308 (`http/TrailingSlash.ts`). Both are in the contract. |
| `proc.test.ts` (4): `kill()` after the exit, the PATH in a spawn failure, a late error event, `fileExists`/`readText`               | `effect/process` and `FileSystem` own them; the message of a spawn failure is Node's.                                                                                                                              |
| `llamaFetch.test.ts` (1): a 204 has a null body                                                                                     | An Effect response has no null body.                                                                                                                                                                               |
| `dev.test.ts` (2): saving a route file keeps llama-server; dev reads `.env.local`                                                   | Nitro behaviour: a saved server file restarts the whole server (`node --watch`), and dev reads `.env` only, like the launcher.                                                                                     |
| `api.test.ts` (2): an empty 2xx is `undefined`; a non-JSON error falls back to the status                                           | The derived client decodes each endpoint's success schema (the 204 of a deletion included) and an undeclared reply as `HttpApi` does.                                                                              |

## Logic that exists twice

`llamacpp-js` is the package that speaks to llama.cpp, written on `fetch`, `node:child_process` and
`node:fs/promises` (Node ≥ 24, to be published). The server may use none of them (no `fetch`, programs through
`effect/process`), so it keeps the pure parts of the package and redoes its I/O:

| The server (lines)                                                                            | Redoes, in `llamacpp-js`                                                   |
| --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `llama/probes.ts` (110): `/health`, `/metrics` and `/slots`, `/props`, "is it a llama-server" | `client.ts`: `probeHealth`, `probeLlamaServer`, `fetchLlama`, `fetchProps` |
| `llama/chatStream.ts` (147): the streamed `/v1/chat/completions`                              | `client.ts`: `streamChatCompletion`                                        |
| `llama/procScan.ts` (34): the pid of a llama-server from `/proc`                              | `node.ts`: `findLlamaServerPid`                                            |
| `flags/Flags.ts`, its `readHelp` (about 23): `llama-server --help`                            | `node.ts`: `loadFlags`                                                     |

About 314 lines of the server redo about 190 of the package. The parsing is not redone: `parsePrometheus`,
`parseSlots`, `parseHelp`, `parseBenchJson`, `parseBenchProgress`, `parseDeviceList`, `parseCmdline`, `portFromArgv`,
`probeUrl`, `benchBinary` and the SSE parser come from `llamacpp-js`. Since #116 the pure parts the port had
rewritten come from the package too, and its own I/O uses them: `healthOf` and `isLlamaHealthBody` (`probes.ts`),
`readChatEvent` and `parseLlamaError` (`chatStream.ts`, which read the events and errors with their own schemas),
`isLlamaServerOn` (`procScan.ts`) and `catalogOfHelp` (`Flags.readHelp`). What exists twice is the transport only. The I/O of the package now serves only its own
users; the server's version adds what the app needs (a bound on every wait, `LlamaHttp` with no limit on the body, the
request tied to the scope of the reply so that a stop closes it).

## Workarounds

Before: 2, both in `app/server/plugins/runtime.ts`:

- nitrojs/nitro#5133: the dev worker's `shutdown` message has no timeout, so the plugin listened to the worker's port
  to undo the runtime before Nitro closed its HTTP server (otherwise an open page held it 5 s, then the runtime was
  never undone);
- nitrojs/nitro#5099: Nitro's `shutdown` hook was unreleased, so the plugin emitted it itself on SIGINT and SIGTERM,
  before srvx's handler, and declared its type.

After: none. The process, its signals and its shutdown belong to the app (`runtime/runApp.ts`, `runtime/Shutdown.ts`),
and dev is `node --watch` behind Vite's proxy (`app/build/devServer.ts`).

## What Effect made simpler

**Shutdown is the order of the layers.** Every service's resources are released by its layer's scope, in the reverse
order of their construction; what must happen while the clients are still connected is a step registered with
`Shutdown.before`, run by the outermost layer:

```ts
// app/server/downloads/Downloads.ts
yield* shutdown.before(
  Effect.gen(function* () {
    const running = yield* SynchronizedRef.modifyEffect(state, (s) =>
      Effect.as(Ref.set(closing, true), [s.loop, s] as const),
    );
    if (Option.isSome(running)) yield* Fiber.interrupt(running.value);
  }).pipe(Effect.withSpan('Downloads.shutdown')),
);
```

The Nitro server wrote the same order by hand in `lib/boot.ts` and `lib/context.ts`, plus the plugin above to make
Nitro call it. The lifecycle suite (SIGTERM with a page open, a reply in progress, a benchmark, a download) passes in
both, and the Effect one exits in 9 ms instead of a second.

**One definition of the API, for the server, the client and the tests.** An endpoint, its parameters, its body and
its errors are declared once in the shared package; the server's handler gets decoded values and can only fail with
the declared errors, the web gets a typed `call` and errors it tells apart by `_tag`, and the contract suite generates
its matrix from the same definition (`HttpApi.reflect` in `contract/cases.ts`: each method a path lacks, a bad and an
unknown id for each `:param`, five broken bodies for each payload). The Nitro server generated a route map from its
files and validated each body in its handler; a status the web compared to decide what failed is now a `_tag`.
Turning every decoding failure into the app's two errors is one middleware:

```ts
// app/server/http/RequestErrors.ts
export const RequestErrorsLive = HttpApiMiddleware.layerSchemaErrorTransform(RequestErrors, (error) => {
  switch (error.kind) {
    case 'Params':
      return Effect.fail(RouteNotFound.make({ message: 'Unknown route' }));
    case 'Payload':
    case 'Query':
    case 'Headers':
      return Effect.fail(requestInvalid(error.cause.issue));
    default:
      return Effect.fail(error);
  }
});
```

**Long-running processes and their state.** llama-server, llama-bench, `nvidia-smi` and the NVML worker are fibers of
a scope: a program is killed (then force-killed) when its scope closes, a wait is bounded by `Effect.timeout`, a
cache that keeps successes and forgets failures is three lines (`Cache.makeWith` with `timeToLive` on the `Exit`, in
`flags/Flags.ts`). The tests drive time with the `TestClock` and replace a service with a layer instead of a module
mock (`ServicesTest`).

**Defects found.** Porting each domain against its written behaviour found what `defects.md` lists: two confirmed
defects of the Nitro server (a `~/…` binary not expanded by the tuning memo and the setup report), fixed with a test,
and the deviations each milestone chose (the V cache of a plan item, the 409 of a resume before it restarts anything,
a sweep's cancel of an unknown id, and others, each in `behaviours.md`).

## What Effect made harder

**More code, and more to know.** 35 % more server code for the same behaviour, a bundle 2.6 times bigger, `check`
and `test` slower. Reading the server needs Effect's vocabulary (layers, scopes, fibers, `Effect.fn`, Schema
classes); the rules that keep it uniform fill `conventions.md` (400 lines), and the Effect guide
(`repos/effect/LLMS.md`) is a prerequisite for anyone writing server code.

**The language service's platform rules.** They forbid `node:*`, `fetch`, timers and `JSON` in the server, and are
blocking. Where Effect has no equivalent, a directive with its reason is needed: four today (`node:http` for
`NodeHttpServer.layer`, `node:crypto` because `Digest` hashes one `Uint8Array` and a download of several GiB is hashed
as it streams, `node:fs/promises` twice because `FileSystem` has no `statfs` and no `rmdir`). The same rules are why
the server redoes the I/O of `llamacpp-js` (above).

**HTTP that is not the framework's shape.** `HttpApi` answers a wrong method with a 404 (no 405 and no `Allow`), and
its router ignores a trailing slash, so `GET /api/settings/` was `GET /api/settings`: the server answers it with a 308
in a middleware of its own (`http/TrailingSlash.ts`). The guard (Host, Origin, media type of a write) and the 500 of
a handler's defect without its message are also written around the router (`http/Guard.ts`, `http/HttpLive.ts`).
Strict decoding of bodies is an annotation of the whole API (`HttpApi.PayloadParseOptions`), and the default error
of a body that is not JSON is a bare 400 until `RequestErrors` turns it into `RequestInvalid`.

## The cost of unstable APIs

Nearly everything beyond Effect's core is `@stability unstable`: `effect/http`, `effect/http-api`, `effect/sql`,
`effect/process`, the CLI and every `@effect/*` package the server uses. The project pays for it three ways:

- `unstableApiUsage` and `apiStabilityLeak` are off: with them on, almost every server file would be flagged;
- `effect` and the `@effect/*` packages are pinned to one exact version (4.1.4) in the `catalog:`, the same as the
  `repos/effect` submodule the code is written against; a bump moves both together, alone, with the suites green;
- what the server relies on in those modules (the shape of a schema error's `kind`, `HttpApi.reflect`, the router's
  handling of a trailing slash, `ChildProcess`'s `forceKillAfter`, the order of a layer's finalizers) is held by the
  server's tests and the contract suite rather than by a stability promise. No unstable API changed under the port
  (one version throughout), so the cost so far is that pin, not a migration.

## Parity

- **The ported tests and the contract suite** pass (979 tests).
- **An existing data directory**: both servers, each on its own copy of the user's database (`~/.local/share/llama-webui`
  copied, never opened in place), answered the same 95 GETs. Every status is the same. The bodies differ only by what
  the port changed on purpose: error bodies are `{ _tag, message }` instead of `{ error }`, `/api/health` gains
  `bootId`, the settings lose `llamaTuiImportDismissed` (the llama-tui import is dropped), and the rest is time,
  sensors and ids.
- **Estimates on the user's models**: `POST /api/tuning/estimate` for four real models (dense and MoE, single and
  split files), every preset, with and without pinned args, and `POST /api/tuning/plan` (`chat` and `big`) for each,
  40 requests per pass. The first pass used the user's `llama.cpp` build, whose device listing fails (below), so
  every estimate is on the CPU; the second pointed the `binary` setting of both copies at the fake binaries
  (`testdata/fake/`), whose `--list-devices` prints the fixture `testdata/llama-bench/list-devices.txt` (two CUDA GPUs
  and a Vulkan one), so the estimates place layers on GPUs. 36 of 40 (CPU) and 38 of 40 (GPUs) are equal up to the
  free RAM read at the time. The others are `chat` plans (four on the CPU, two with GPUs) whose items set
  `-ctk q8_0`: the new plan measures them with the f16 V cache llama.cpp gives them, where the Nitro plan assumed a
  q8_0 V cache (a fix of E8, `defects.md`, E8), so their RAM or VRAM is 39 to 126 MB higher.
- **Found on the way**:
  - The user's own `llama.cpp` build does not start: `llama-bench --list-devices` exits with code 127 and
    `llama-server --help` fails, on both servers, because the binaries link `libblis.so.5` and `/opt/aocl` only has
    `libblis.so.6`. Not a defect of either server; Tuning, Bench and the flag catalogue show that error until the
    binaries are rebuilt or the library provided.
  - The web router still held the `PORTED` placeholders of the port (pages shown only once their milestone was done);
    they were removed at E10 and the router is back to its form of `master`.
- **The user** validates the running app (E10).
- **After the review of `defects.md` (E11)**, six design choices changed at the user's call, so these behaviours no
  longer match `master` on purpose: NVML restarts then nvidia-smi, model paths confined to the models folder and the
  profiles' files (403 `ModelPathRefused`), a model's profiles deleted before its files in one transaction, the bench's
  end published at shutdown, `BenchFileMissing` a 404, and the ROCm check per card (`behaviours.md`, E11).

## A basis for the decision

For merging:

- the behaviour is the same, written down per endpoint and tested, with no workaround left and a shutdown that no
  longer waits;
- one definition of the API holds the server, the client and the contract suite together: an error is a tag the web
  reads, a body that does not decode never reaches a handler, and an endpoint without a test fails the coverage check;
- long-running work (llama-server, benchmarks, downloads, chat replies) has its lifetime in its scope, which is where
  the Nitro server had its hand-written order and its two workarounds.

Against:

- 35 % more server code, a bundle 2.6 times bigger, `check` and `test` about 1.7 times slower;
- a server only someone who knows Effect can change, under a set of rules (`conventions.md`, the blocking
  diagnostics) that has to be kept;
- a pin on one version of unstable modules, and a server that redoes `llamacpp-js`'s I/O instead of using it.

What is left open: `defects.md` is to be reviewed (nothing in it was fixed on `master`), and the user's validation of
the running app.
