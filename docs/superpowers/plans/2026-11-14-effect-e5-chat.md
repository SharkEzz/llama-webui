# Effect POC, E5: Chat Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring the chat back under the Effect server: conversations and messages in SQLite, a reply streamed from
llama-server through `LlamaHttp` and saved as it goes, at most one reply per conversation that goes on without any
client, stop, regenerate, follow-up of a reply in progress, the reply saved "stopped" at shutdown; the `/api/chat*`
endpoints with their SSE replies; on the web the Chat page.

**Architecture:** The shared package gets the chat types as schemas (zod leaves `chat.ts`) and one API group
(`chat`) whose three streaming endpoints declare an `HttpApiSchema.StreamSse` success, so the web's derived client
decodes the reply as a `Stream` of `ChatEvent`. The server gets a `chat/` folder: `ConversationsRepo` (SQL),
`request.ts` (the body sent to llama-server and the wording of its failures), `llama/chatStream.ts` (one streamed
`/v1/chat/completions` through `LlamaHttp`, its failures tagged), and `ChatRuns` (the replies in progress: one fiber
each in the layer's scope, their state in one `SynchronizedRef`, their events through a `PubSub`, a shutdown step that
saves them "stopped").

**Tech Stack:** Effect 4.1.4 (`effect`, `effect/http-api` `HttpApiSchema.StreamSse`, `effect/sql`,
`effect/encoding`), `@effect/platform-node`, `llamacpp-js` pure modules (`sse`, `errors`, `client` types), Vitest 5,
`@effect/vitest`, Biome.

**Spec:** `docs/superpowers/specs/2026-11-14-effect-server-design.md` (E5 row; "WebSocket and streams": "The chat
reply stream stays Server-Sent Events over HTTP, built from a `Stream`, with its keep-alive comment"). Acceptance list:
`docs/superpowers/poc-effect/behaviours.md`, section E5 (and its `From E1:` and `From E3:` lines). Rules:
`docs/superpowers/poc-effect/conventions.md`.

**Calls made by this plan** (the author's; each is recorded by Task 7):

- **The streaming endpoints are `HttpApi` endpoints**, not plain routes: `messages`, `regenerate` and `stream` declare
  `success: HttpApiSchema.StreamSse({ events: ChatSseEvent })` (one SSE event per `ChatEvent`, its `event:` the type,
  its `data:` the JSON). Their handlers answer with the existing `sseResponse` of `app/server/http/Sse.ts`
  (`handleRaw`), which keeps the Nitro stream's headers (`cache-control`, `x-accel-buffering`, `connection: close`)
  and its `: ping` comment every 15 s; the web's client decodes the same bytes. Task 1 verifies that a `handleRaw`
  handler still answers its declared errors with their status; if not, it stops and reports (the fallback, `handle`
  returning the `Stream` with `keepAlive`, changes the ping comment and the headers).
- **`GET /api/chat/:id/stream` answers 204 when no reply runs**, as today: its success is the `StreamSse` and an empty
  204 (`HttpApiSchema.NoContent` or the equivalent of `effect/http-api`), the client sees `void`.
- **Errors are tagged:** `ConversationNotFound` (404 `Conversation not found`), `ReplyInProgress` (409 `A reply is
  already in progress in this conversation`), `NoReplyInProgress` (409 `No reply in progress`), `NothingToRegenerate`
  (409 `Nothing to regenerate`), `EmptyMessage` (400 `Empty message`), and the existing `ServerNotReady` (409
  `llama-server is not ready`) and `ProfileNotFound` (404). Messages kept word for word.
- **Requests are strict**, as E2 to E4 set: `POST /api/chat` takes `{ profileId?: Int | null }` (any other key or
  type is a 400 `RequestInvalid`; was `profileId: expected an integer or null`), `POST /api/chat/:id/messages` takes
  `{ content: String }` (a non-string is a 400 `RequestInvalid`; was `content: expected a string`), `PATCH` takes the
  `ConversationPatch` schema with the limits and messages of today's zod schema.
- **Two sends at once to one conversation give one reply and one 409**: the check "a reply runs" and the registration
  of the new run are one step (the Nitro server got this from JavaScript's single thread; the Effect server must make
  it so).
- **`stop` of a conversation that does not exist answers 409** `No reply in progress` as today (defects.md E5:
  `design choice`). `liveIds()` (never called) is not ported. The comment of `stopOrphans` is corrected: it writes
  `stopped`.
- **llama-server's `timings` are decoded with a schema** before they become `MessageStats`: a missing field leaves the
  stats null instead of a NaN that would stop the `done` event from encoding.
- Time is the `Clock`'s (the 1000 ms throttle, the ttft and the duration): the throttle is tested on the `TestClock`.

## Global Constraints

- Branch `poc/effect`, after E4 (`docs(poc): Record the fixes of the E4 final review`). Commit on it; the controller
  pushes.
- **Before writing any Effect code, read `repos/effect/LLMS.md` completely**, then
  `docs/superpowers/poc-effect/conventions.md`, then the reference files of the task. `repos/effect` is the installed
  version (4.1.4): read it, not `node_modules`, and never edit it. `HttpApiSchema.StreamSse` is in
  `repos/effect/packages/effect/src/http-api/HttpApiSchema.ts` (~line 550), its server side in `HttpApiBuilder.ts`
  (`makeStreamEncoder`, `handleRaw`), its client side in `HttpApiClient.ts`.
- **Effect diagnostics are blocking:** `pnpm check 2>&1 | grep -c 'effect('` prints `0`, warnings included. The only
  change of `tsconfig.effect.json`: `packages/webui-shared/src/chat.ts` joins the third override (Task 1). No new
  `@effect-diagnostics` directive. Any rule that seems wrong for a piece of code: stop and report, do not lower it.
- Idiomatic Effect only (conventions): services are `Context.Service` classes keyed
  `@llama-webui/app/server/<path>/<Name>` with their layers as statics, methods `Effect.fn('Service.method')`, errors
  `Schema.TaggedError` built with `X.make(…)`, time from `Clock`, SQL through `SqlClient`. Promise code wrapped in
  `Effect.promise` does not count as ported.
- **The chat does not use the I/O of `llamacpp-js`** (`streamChatCompletion`, `llamaFetch`: spec, "Outside world"):
  the request goes through `LlamaHttp`. Its pure modules may be imported: `SseParser` (`llamacpp-js/sse`),
  `contextOverflow` and the `LlamaError` type (`llamacpp-js/errors`), `probeUrl` and the `LlamaTimings` type
  (`llamacpp-js/client`). `Llama*Error` classes are not thrown: their cases become tagged errors.
- `app/server-legacy/` is a read-only reference: port behaviour, not structure; never import it. Only Task 7 deletes
  files in it (`lib/llamaFetch.ts` and its test stay: E6 reads `downloadFetch`).
- A reply carries what is stored: its schema has no input rule (conventions, "Replies"): `Conversation.sampling` is
  the stored sampling without the limits of `Sampling`'s input schema.
- Server and shared code runs under Node as it is: relative imports end in `.ts`, erasable syntax only.
- No dependency is added; zod stays in the catalog (other modules still use it) but leaves `chat.ts`.
- **Never start anything on port 7860 or 7861**, nor on the default data folder. Tests never use port 8080: every
  profile of a test sets its own free port.
- Tests on real time (processes, sockets, the fake llama-server): `layer(L, { excludeTestServices: true })`. A test that
  starts a process asserts it is dead at the end. The fake llama-server (`testdata/fake/`, `app/server/testing/llama.ts`)
  streams a chat reply (`FAKE_CHAT_DELAY_MS`, `FAKE_CHAT_LINES`).
- Code, comments, test names, messages and commits in English. Commits end with
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- `pnpm lint`, `pnpm check` and `pnpm test` green at the end of every task, except the two known `dev.test.ts` timing
  tests of this container (`in dev, without Effect DevTools, a restart does not wait for them`, and `one SIGINT stops
  vite dev and the server`, which fails only after it). Zero Biome warning. Format a Markdown or JSON file you wrote
  with `pnpm exec biome check --write <file>`.

## Facts verified on this tree

- `app/server/http/Sse.ts` `sseResponse(events, { pingInterval })` turns a `Stream<{ event?, data }>` into a
  `text/event-stream` response with the Nitro headers and a `: ping` comment after each silence of `pingInterval`
  (15 s); a client that goes away interrupts the stream (E1, `Sse.test.ts`).
- `HttpApiSchema.StreamSse({ events })` declares an SSE success; the server encodes a `Stream` returned by `handle`
  with only `content-type` (no `cache-control`, no `connection: close`) and writes `: keepalive` comments when
  `keepAlive` is set; the client decodes the body into a `Stream` of events. `HttpApiBuilder` groups also have
  `handleRaw` (the handler answers an `HttpServerResponse`).
- `LlamaHttp` (`app/server/llama/LlamaHttp.ts`): `node:http`, direct, no time limit of its own, each request in its
  caller's scope (leaving the scope aborts it; conventions, "`LlamaHttp`").
- The tables `conversations` and `messages` exist (`app/server/db/migrations.ts` `0004`–`0006`), with
  `ON DELETE CASCADE` and foreign keys on (`Db.ts`).
- `profilePaths({ profile, home, cwd, path })` (`app/server/supervisor/command.ts`) gives a profile's model path as
  llama-server opens it; the monitor resolves it this way (`app/server/monitor/Monitor.ts` ~184, `homeDir` of
  `config/Home.ts`, `cwd` `path.resolve('.')`).
- `Supervisor.state` gives `ready` (`host`, `port`, `profileId`) or `external` (`port`); `ServerNotReady` (409
  `llama-server is not ready`) and `ProfileNotFound` (404) already exist in `@llama-webui/shared`.
- The web's Chat page (`app/src/features/chat/`) imports `stem` of `@/lib/models` (E6's store) and `ApiError` of
  `@/lib/api` (gone since E1); `app/src/lib/chat.ts` still calls the deleted `api('…')` and `request('…')`.

## Reference files

- Legacy behaviour (read, never import), under `app/server-legacy/`: `lib/chat/{runs,request,sse}.ts` and their tests,
  `lib/db/conversations.ts`, `routes/api/chat/**`, `lib/llamaFetch.test.ts` (`streamChatCompletion streams through it
  and stops the request when left early`), the chat tests of `lib/routes.test.ts`, `lib/boot.ts` (orphans, stop order),
  `lib/deps.ts` (the target); `packages/llamacpp-js/src/{client,sse,errors}.ts` (to port, not to call).
- The models: `app/server/profiles/ProfilesRepo.ts` (a repository on `SqlClient`), `app/server/supervisor/Supervisor.ts`
  (state in one `SynchronizedRef`, an operation that outlives its request), `app/server/llama/probes.ts` (a request
  through `LlamaHttp`), `app/server/http/Sse.ts`, `app/server/runtime/Shutdown.ts` (a shutdown step),
  `app/server/monitor/http.ts` (a group's handlers).

## Review Focus

- **Two sends at once to one conversation** (a double click, two tabs): one reply runs, the other request gets the
  409, no second assistant message is stored. Test: Task 4, `two sends at once give one reply and one 409`.
- **A client that leaves mid-reply** (closed tab, reload): the reply goes on and is saved `done`; a new
  `GET /api/chat/:id/stream` replays what was written then follows. Test: Task 5, `a client that leaves only
  unsubscribes, and the reply is followed again by stream`.
- **llama-server crashes mid-reply:** the reply is saved `error` with its partial text and `llama-server cut the reply
  short (stopped or crashed)`, the run leaves the table, and a new message can be sent once a server is ready. Test:
  Task 4, `a stream cut short is an error that keeps the partial answer, and the conversation takes a new message`.
- **Deleting a conversation during a reply:** the reply stops, nothing is written after the delete, no failure is
  logged as a crash, the delete answers 204 and the messages are gone. Test: Task 5, `deleting a conversation during
  a reply stops it and deletes its messages`.
- **Stopping the app during a reply** (Ctrl-C with the Chat open): under 2 s, the SSE ends with `done`, the reply is
  saved `stopped` with its partial text, llama-server stopped after. Test: Task 5, in `app/server/lifecycle.test.ts`.

---

### Task 1: Schemas and the chat group

**Files:**

- Modify: `packages/webui-shared/src/chat.ts`, `packages/webui-shared/src/chat.test.ts`,
  `packages/webui-shared/src/index.ts`, `tsconfig.effect.json`
- Create: `packages/webui-shared/src/api/ChatApi.ts`, `packages/webui-shared/src/api/ChatApi.test.ts`

**Interfaces:**

- Produces (in `@llama-webui/shared`, each a schema with its `type X = typeof X.Type`):
  - `Sampling` (input: each key optional, the limits and messages of today's zod schema: `'<Label>: between <min> and
    <max>'`, `'Expected a number'`, `'Expected an integer'`, unknown key refused), `StoredSampling` (same keys, no rule:
    what a reply carries), `ConversationPatch` (`title` trimmed 1–200 `'Required'` / `'200 characters at most'`,
    `systemPrompt` ≤ 100 000 `'System prompt too long'`, `sampling: Sampling`, `thinking: Boolean`, all optional,
    unknown key refused), `MessageStatus`, `MessageStats` (numbers `Finite`, `ttftMs`/`draftN`/`draftAccepted`
    nullable), `ChatMessage`, `Conversation`, `ConversationSummary`, `ConversationDetail`, `ChatEvent` (the union of
    `{ type: 'start', user: NullOr(ChatMessage), assistant: ChatMessage }`, `{ type: 'delta', content?, reasoning? }`,
    `{ type: 'done', message: ChatMessage }`), `LlamaTimingsSchema` (the fields `statsFromTimings` reads: `prompt_n`,
    `prompt_per_second`, `predicted_n`, `predicted_per_second` required, `cache_n`, `draft_n`, `draft_n_accepted`
    optional); `statsFromTimings`, `contextUsed`, `autoTitle`, `isDefaultTitle`, `DEFAULT_TITLE` keep their signatures.
  - `api/ChatApi.ts`: the errors above (with `httpApiStatus`), `ChatSseEvent` (the SSE event codec of a `ChatEvent`:
    `event` the type, `data` its JSON), and `ChatApi`, group `chat`: `list` (`GET /api/chat`, `Array(ConversationSummary)`),
    `create` (`POST /api/chat`, payload `{ profileId?: NullOr(Int) }`, success 201 `ConversationDetail`, error
    `ProfileNotFound`), `get` (`GET /api/chat/:id`), `patch` (`PATCH /api/chat/:id`, payload `ConversationPatch`),
    `remove` (`DELETE /api/chat/:id`, 204), `send` (`POST /api/chat/:id/messages`, payload `{ content: String }`,
    success `StreamSse`, errors `EmptyMessage`, `ConversationNotFound`, `ReplyInProgress`, `ServerNotReady`),
    `regenerate` (`POST /api/chat/:id/regenerate`, success `StreamSse`, errors `ConversationNotFound`,
    `ReplyInProgress`, `ServerNotReady`, `NothingToRegenerate`), `stop` (`POST /api/chat/:id/stop`, 204, error
    `NoReplyInProgress`), `follow` (`GET /api/chat/:id/stream`, success `StreamSse` or 204, error
    `ConversationNotFound`). Every `:id` is `IdParam`. `Api` does not add it yet (Task 5, with its handlers).

- [ ] **Step 1: Verify the SSE path with a throwaway test** (not committed): a one-group API whose endpoint declares
      `StreamSse` and an error with status 409, served by `handleRaw` answering `sseResponse(…)`; the derived client
      (on the test server, `app/server/testing/http.ts`) receives the events as a `Stream`, and the handler's failure
      with the error reaches the client as that error with status 409. Also: an endpoint whose success is the
      `StreamSse` or an empty 204 decodes a 204 as `void`. Record what you found in the report; if either fails, stop
      and report (the plan's first call depends on it).
- [ ] **Step 2: Write the failing tests.** `chat.test.ts`: keep the four existing tests; add `Sampling refuses a value
      out of its range with the label's message` (`temperature: 6` → `Temperature: between 0 and 5`; `top_k: 1.5` →
      `Expected an integer`; an unknown key refused), `ConversationPatch trims the title and refuses an empty one`
      (`'  a  '` → `'a'`; `'   '` → `Required`; 201 characters → `200 characters at most`), `statsFromTimings of decoded
      timings without cache_n counts 0 cached`. `ChatApi.test.ts`: `a ChatEvent round-trips through its SSE event`
      (each of the three types encoded by `ChatSseEvent` then decoded equal).
- [ ] **Step 3:** they fail. **Step 4: Implement**, move `chat.ts` to the third override, check the barrel for name
      clashes (conventions), fix the web's type fallout as readonly parameters only (its Chat page is not routed).
- [ ] **Step 5:** `pnpm lint`, `pnpm check`, `pnpm test` green. Commit `feat(shared): Describe the chat with Schema`.

### Task 2: The conversations repository

**Files:**

- Create: `app/server/chat/ConversationsRepo.ts`, `app/server/chat/ConversationsRepo.test.ts`

**Interfaces:**

- Produces `class ConversationsRepo extends Context.Service<ConversationsRepo, { … }>` keyed
  `@llama-webui/app/server/chat/ConversationsRepo`, `ConversationsRepo.layer: Layer<ConversationsRepo, never,
  SqlClient>`, with (each an `Effect.fn`, SQL failures `orDie` as in `ProfilesRepo`):
  `list: Effect<ReadonlyArray<Omit<ConversationSummary, 'live'>>>` (by `updated_at` desc then `id` desc, with
  `messageCount`), `get(id): Effect<Conversation, ConversationNotFound>`, `messages(id): Effect<ReadonlyArray<ChatMessage>>`
  (by id), `create({ profileId, modelPath }): Effect<Conversation>` (title `New conversation`, sampling `{}`, system
  prompt `''`, thinking true), `patch(id, ConversationPatch): Effect<Conversation, ConversationNotFound>` (an omitted
  field kept, `sampling` replaced whole, `updated_at` bumped even for `{}`), `remove(id): Effect<void,
  ConversationNotFound>`, `setTitle(id, title)`, `setModel(id, profileId, modelPath)` (no `updated_at` bump),
  `addMessage(id, { role, content, status, model? }): Effect<ChatMessage>` (bumps the conversation's `updated_at`),
  `updateMessage(messageId, { content?, reasoning?, status?, error?, stats? }): Effect<ChatMessage,
  MessageNotFound>` (`MessageNotFound` a server-side tagged error: the conversation was deleted),
  `deleteFrom(id, messageId)` (that message and every later one), `stopOrphans: Effect<number>` (every `streaming`
  message set to `stopped`). Rows decoded with `Schema` (`sampling_json`, `stats_json` through `Schema.fromJsonString`;
  a stored value that no longer decodes is kept as stored: `StoredSampling` has no rule).

- [ ] **Step 1: Write the failing tests** (`layer(…)` on `Db.layerAt(':memory:')`, a fresh database per test that needs
      one): `create, get and list order by updated_at then id`, `patch stores the fields, trims the title, replaces the
      sampling whole and bumps updated_at even for {}`, `setModel does not bump updated_at`, `addMessage bumps the
      conversation and messages come back by id`, `updateMessage of a deleted conversation's message fails with
      MessageNotFound`, `deleteFrom removes the message and every later one`, `remove deletes the messages by cascade`,
      `stopOrphans marks every streaming message stopped and counts them`, `a row written by the Nitro server reads
      back` (insert by SQL the legacy shapes: `sampling_json '{}'`, a `stats_json` with every field, `thinking 1`).
- [ ] **Step 2:** they fail. **Step 3: Implement.** **Step 4:** green gates. Commit `feat(server): Keep the
      conversations and their messages in SQLite`.

### Task 3: A chat reply from llama-server

**Files:**

- Create: `app/server/llama/chatStream.ts`, `app/server/llama/chatStream.test.ts`, `app/server/chat/request.ts`,
  `app/server/chat/request.test.ts`

**Interfaces:**

- Produces:
  - `chatStream.ts`: the tagged failures `LlamaHttpFailed { status: Int, body: String, error: Option<LlamaError> }`,
    `LlamaStreamFailed { error: LlamaError }`, `LlamaStreamCut`, `LlamaUnreachable { message }` (server-side
    `Schema.TaggedError`s; `LlamaError` the shape of `llamacpp-js/errors`), `ChatChunk` (the fields read:
    `choices[0].delta.content`, `choices[0].delta.reasoning_content`, `timings` as `LlamaTimingsSchema`, each
    optional), and `streamChat(baseUrl: string, body: unknown): Stream.Stream<ChatChunk, LlamaHttpFailed |
    LlamaStreamFailed | LlamaStreamCut | LlamaUnreachable, LlamaHttp>`: one `POST <baseUrl>/v1/chat/completions` (JSON
    body) through `LlamaHttp` in the stream's scope (ending or interrupting the stream aborts the request); a non-2xx
    status is `LlamaHttpFailed` (the JSON `error` of the body when there is one); the body parsed as SSE (`SseParser` of
    `llamacpp-js/sse`, or `effect/encoding/Sse`), `data: [DONE]` ends the stream, an `error` event is
    `LlamaStreamFailed`, a body that ends or breaks before `[DONE]` is `LlamaStreamCut`, a request that never connects is
    `LlamaUnreachable`; a chunk that does not decode is skipped.
  - `request.ts`: `buildChatRequest(conversation: Conversation, history: ReadonlyArray<ChatMessage>): unknown` (the rules
    of the E5 line "The request body holds…") and `failureMessage(failure): string` (the wording of the E5 line "A
    failed reply's error reads…", with `fmtInt` for the sizes).

- [ ] **Step 1: Port and write the tests.** `request.test.ts`: the three tests of
      `app/server-legacy/lib/chat/request.test.ts`, same names and assertions (`llamaErrorMessage` becomes
      `failureMessage` of a `LlamaStreamFailed`/`LlamaHttpFailed`); add `stopped replies stay in the history sent to
      llama-server` and `failureMessage words an HTTP error without JSON, a cut stream and an unreachable server`.
      `chatStream.test.ts` (on `httpStub` of `app/server/testing/llama.ts`, real time): `streamChat streams the deltas
      and the timings until [DONE]`, `an error status with a JSON error is LlamaHttpFailed with that error`, `a stream
      error event is LlamaStreamFailed`, `a body that ends before [DONE] is LlamaStreamCut`, `nothing listening is
      LlamaUnreachable`, and the rewrite of the legacy `streamChatCompletion streams through it and stops the request
      when left early` (taking two chunks then ending the stream closes the stub's request: its `close` is seen).
- [ ] **Step 2:** they fail. **Step 3: Implement.** **Step 4:** green gates. Commit `feat(server): Stream a chat reply
      from llama-server through LlamaHttp`.

### Task 4: The replies in progress

**Files:**

- Create: `app/server/chat/ChatRuns.ts`, `app/server/chat/ChatRuns.test.ts`, `app/server/chat/target.ts`

**Interfaces:**

- Consumes: `ConversationsRepo` (Task 2), `streamChat`, `buildChatRequest`, `failureMessage` (Task 3), `Supervisor.state`,
  `ProfilesRepo.get`, `profilePaths`, `Shutdown`.
- Produces:
  - `target.ts`: `ChatTarget = { host: string | null; port: number; profileId: number | null; modelPath: string | null }`
    and `chatTarget: Effect<Option<ChatTarget>, never, Supervisor | ProfilesRepo | Path>`: the managed server when
    `ready` (its `--host`, port, profile id and the profile's model path), an external server on loopback at its port
    (profile and model null), else none.
  - `class ChatRuns extends Context.Service<ChatRuns, { send(id, content): Effect<ChatReply, EmptyMessage |
    ConversationNotFound | ReplyInProgress | ServerNotReady>; regenerate(id): Effect<ChatReply, ConversationNotFound |
    ReplyInProgress | ServerNotReady | NothingToRegenerate>; stop(id): Effect<void, NoReplyInProgress>; live(id):
    Effect<Option<ChatReply>>; isLive(id): Effect<boolean>; stopAndWait(id): Effect<void> }>` where `ChatReply = {
    readonly events: Stream.Stream<ChatEvent> }` (subscribed when the stream starts: `start`, one cumulative `delta` of
    what was written when there is any, then `done` at once if the reply ended, else the live events until `done`).
    `ChatRuns.layerWith({ flushInterval: Duration.Input; target?: Effect<Option<ChatTarget>> })` and `ChatRuns.layer`
    (1000 ms; `chatTarget`). Needs `ConversationsRepo`, `LlamaHttp`, `Shutdown` (and what `chatTarget` needs).
  - Behaviour, the rules of the E5 "Background work" lines and of `app/server-legacy/lib/chat/runs.ts`:
    - the layer marks the orphans (`stopOrphans`) when it is built;
    - `send` trims the text (`EmptyMessage` when blank), then in one step under the runs' lock: the conversation exists,
      no run for it (`ReplyInProgress`), a target (`ServerNotReady`), the user message stored, the auto-title on the
      first user message of a default-titled conversation, the conversation takes the target's model when it has
      none, the assistant message stored `streaming` with the target's model, the run registered; `regenerate` the same
      after deleting from the message that follows the last user message (`NothingToRegenerate` without one), its
      `start` with `user: null`;
    - each run is a fiber forked in the layer's scope that consumes `streamChat`: each non-empty delta appended and
      published, the ttft at the first one, the last `timings` kept, the text written `streaming` on a delta at least
      `flushInterval` after the start or the last write (the `Clock`);
    - at its end the reply is saved `done`, `stopped` (after `stop`) or `error` with `failureMessage`, its stats from the
      decoded timings (none without), `done` published with the saved message (built in memory on `MessageNotFound`),
      the run removed;
    - `stop` ends the run's consumption (its request aborted) and returns without waiting; `stopAndWait` stops and
      waits for the run's end (for the delete);
    - a shutdown step (`shutdown.before`): every run is stopped, saved `stopped` at once with its text so far, `done`
      published (the SSE responses end), and nothing is written by it afterwards; the layer's end interrupts what is
      left.

- [ ] **Step 1: Port and write the tests** (`layer(…, { excludeTestServices: true })` on `ServicesTest` and an
      `httpStub` llama-server whose chunks the test releases one by one, as the legacy `setup()` did; a `target` of
      `layerWith` pointing at it). Port the five tests of `app/server-legacy/lib/chat/runs.test.ts` (same names). Add:
      `two sends at once give one reply and one 409` (Review Focus), `a stream cut short is an error that keeps the
      partial answer, and the conversation takes a new message` (Review Focus), `an HTTP error, a stream error event
      and an unreachable server are worded for the conversation`, `the text is written at most once per flushInterval`
      (on the `TestClock`: two deltas 500 ms apart write once, a third 1000 ms later writes again), `the first reply of
      a conversation without a model takes the target's`, `a reply against an external server has no profile and no
      model`, `the auto-title is given on the first user message only`, `regenerate replaces what follows the last
      user message`, `regenerate without a user message is NothingToRegenerate`, `send with no ready server is
      ServerNotReady`, `a blank message is EmptyMessage`, `the done message is built in memory when the conversation
      was deleted`, `orphans are marked stopped when the layer is built`. Every test asserts no run is left.
- [ ] **Step 2:** they fail. **Step 3: Implement.** **Step 4:** green gates. Commit `feat(server): Run the chat replies
      and save them as they stream`.

### Task 5: The chat over HTTP

**Files:**

- Create: `app/server/chat/http.ts`, `app/server/chat/http.test.ts`
- Modify: `packages/webui-shared/src/api/Api.ts` (`.add(ChatApi)` after `MonitorApi`), `app/server/http/HttpLive.ts`,
  `app/server/App.ts`, `app/server/testing/services.ts`, `app/server/contract/cases.ts`,
  `app/server/contract/golden.json`, `app/server/lifecycle.test.ts`

**Interfaces:**

- Produces `ChatHandlers`: `list` (each summary with `live`), `create` (the `profileId` rules of the E5 line
  `POST /api/chat`: omitted → the profile of the managed server while `starting`, `ready` or `stopping`, else none;
  `null` → none; an id → that profile, `ProfileNotFound` when missing; the model path through `profilePaths`), `get`
  and `patch` (the detail with `live`), `remove` (`stopAndWait` then delete), `send`, `regenerate` and `follow`
  (`handleRaw`: `sseResponse` of the reply's events, each `ChatEvent` as `{ event: type, data: JSON }`, encoded with
  `ChatSseEvent`; `follow` answers 204 without a run), `stop`.
- Tiers of `App.ts`: `ChatRuns.layer` and `ConversationsRepo.layer` above the supervisor (the runs end, saved, before
  llama-server stops); `ConversationsRepo` with the repositories. `ServicesTest` gets them too.

- [ ] **Step 1: Write the failing tests.** `chat/http.test.ts` (`HttpApiTest` or the test server on `ServicesTest`, the
      fake llama-server started through the supervisor for the streaming ones): port the four chat tests of
      `app/server-legacy/lib/routes.test.ts` (same names; `#37`'s string `profileId` is now a 400 `RequestInvalid`);
      add `a successful PATCH stores the fields and answers the detail`, `deleting a conversation during a reply stops
      it and deletes its messages` (Review Focus), `stop answers 204 and the reply is saved stopped`, `live is true in
      the list and the detail while a reply runs`, `a client that leaves only unsubscribes, and the reply is followed
      again by stream` (Review Focus), `send answers 409 llama-server is not ready without a server`, and the SSE
      headers (`cache-control`, `connection: close`, `content-type: text/event-stream`) of a reply. Raw HTTP for the
      validation cases (`send` in `profiles/http.test.ts`).
  - Contract: one case per endpoint (`covers`), the `violation` cases (a string `profileId`, a non-string `content`, an
    unknown PATCH key, a `title: 5`), the `refusal` cases (404 of an unknown id for each endpoint, 409 `No reply in
    progress`, 409 `llama-server is not ready` on `messages`, 409 `Nothing to regenerate` with the fake server ready if
    the contract can start it, else noted), recorded with `UPDATE_GOLDEN=1`, then the diff of `golden.json` read: new
    cases only, plus the cases that move from the 404 of a missing route to the chat's answers.
  - `lifecycle.test.ts`: the half `From E1` left out: `SIGTERM with the UI open and a reply streaming stops in under 2
    s, ends the stream with done and saves the reply stopped` (the build, the fake llama-server started through the
    API with `FAKE_CHAT_DELAY_MS` long, a message sent and its SSE read until a delta, SIGTERM; exit 0 under 2 s, the
    stream's last event `done` with `status: 'stopped'`, the row `stopped` in the data folder's database, the fake
    dead) (Review Focus).
- [ ] **Step 2:** they fail. **Step 3: Implement** the handlers and the wiring. **Step 4:** green gates (`pnpm build`
      before the build-driven suites). Commit `feat(server): Serve the chat and its replies as SSE`.

### Task 6: The Chat page

**Files:**

- Modify: `app/src/lib/api.ts` (a stream call), `app/src/lib/chat.ts`, `app/src/features/chat/*.tsx`,
  `app/src/app/router.tsx`, `app/src/app/routes.ts`, `app/tsconfig.json` (if needed), and the golden's entry
  modulepreload list
- Modify: `docs/superpowers/poc-effect/behaviours.md` (a `From E5:` line for any part removed until a later store)

**Interfaces:**

- Produces in `app/src/lib/api.ts`: `callStream<A, E>(f: (client) => Effect<Stream<A, E2>, E>, onEvent: (a: A) => void,
  options?: { signal?: AbortSignal }): Promise<void>` (resolves when the stream ends, rejects with the endpoint's tagged
  error or `ApiUnreachable`, an abort ends it without an error), on the same runtime as `call`.

- [ ] **Step 1:** Move `lib/chat.ts` to `call` and `callStream` (`api.chat.send({ params, payload })`,
      `api.chat.follow(…)`, a 204 of `follow` meaning no reply), tell errors by `_tag` (`SamplingPanel`'s `ApiError`
      becomes the `RequestInvalid` issues on their fields, as `features/profiles/errors.ts` does); `stem` of
      `@/lib/models`: if that module does not compile without E6's store, move `stem` (a pure function) to a module the
      page can import, without changing it; put `/chat` and `chat/:id` back in `PORTED` and out of `MILESTONE_BY_PATH`.
- [ ] **Step 2:** `pnpm check`, the web tests, `pnpm build`; the golden's modulepreload list re-recorded and read.
- [ ] **Step 3: Look at the page.** The build on a scratch data folder and a free port, the fake llama-server started
      through the API (`startFakeThrough`), Chromium (Playwright, `deviceScaleFactor: 1`): create a conversation, send a
      message and see the reply stream in, stop a reply, regenerate, reload during a reply and see it followed, rename
      and delete; no console error. Screenshots in the session's scratchpad; every process stopped at the end.
- [ ] **Step 4:** green gates. Commit `feat(web): Bring the Chat page back`.

### Task 7: Close the milestone

**Files:**

- Modify: `docs/superpowers/poc-effect/behaviours.md`, `test-inventory.json`, `defects.md`, `conventions.md`,
  `CLAUDE.md` (only a rule a contributor needs that changed)
- Delete: `app/server-legacy/lib/chat/`, `lib/db/conversations.ts`, `routes/api/chat/`
- Create: `docs/superpowers/poc-effect/e5.json`

- [ ] **Step 1: Behaviours.** Section E5: every line ticked with its proof (test file and name, or contract case), in
      the format of E1 to E4; a changed line says how it behaves now (the calls of this plan); every "Not covered by a
      test" line ticked with the test this plan added, or moved; the `From E1:` and `From E3:` lines ticked.
- [ ] **Step 2: Tests.** The eighteen `E5` entries of `test-inventory.json` get a status (throwaway script, never
      regenerated): `ported`, `rewritten` with its new place (`llamaFetch: streamChatCompletion…` →
      `chatStream.test.ts`, the `#37` POST test, `wire.test.ts`'s `readSse` if it moved), or `dropped` with a reason.
- [ ] **Step 3: Defects and deviations.** `defects.md` section E5: `stopOrphans`'s comment → `fixed in E5`; `liveIds()`
      → `confirmed`, not ported; stop of an unknown id → `design choice`. Under "Changed by the Effect server", one line
      per call of this plan and per deviation found while porting.
- [ ] **Step 4: Conventions.** From the code as it is: an endpoint whose success is a stream (`StreamSse` declared,
      `handleRaw` with `sseResponse`, the web's `callStream`); a state of several runs with one lock for check-and-
      register; a shutdown step that saves before llama-server stops.
- [ ] **Step 5: Legacy files.** `git rm` the files listed above; keep `lib/llamaFetch.ts` and its test (E6),
      `lib/boot.ts`, `lib/deps.ts`, `lib/context.ts`, `lib/routes.test.ts`; nothing kept may need a deleted file for a
      later milestone (check with `grep`).
- [ ] **Step 6:** `pnpm lint && pnpm check && pnpm test && pnpm build && node scripts/smoke.ts`,
      `pnpm --filter llamacpp-js test`, `pnpm check 2>&1 | grep -c 'effect('` (0), `pgrep -f fake-llama-server`
      (nothing). Commit `chore(poc): Close E5, the chat`.
- [ ] **Step 7:** `node scripts/poc/measure.ts --out docs/superpowers/poc-effect/e5.json` (`--skip-durations` if
      `pnpm test` exits non-zero on the two known timing tests, the times taken by hand in the report), format, commit
      `chore(poc): Measure E5`.
- [ ] **Step 8: Report.** Per task what was built; every deviation and why; every place the plan was wrong; every
      behaviour dropped, changed or moved; directives and override entries (expected: `chat.ts` in the third override
      only); what Task 6 Step 3 showed; `e5.json` next to `e4.json`; anything left undone.
