import { assert, describe, layer } from '@effect/vitest';
import {
  Api,
  type ChatEvent,
  type ChatMessage,
  ChatSseEvent,
  ConversationDetail,
  ConversationSummary,
  type ServerState,
} from '@llama-webui/shared';
import {
  Array as Arr,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Schedule,
  Schema,
  Scope,
  String as Str,
  Stream,
} from 'effect';
import { Sse } from 'effect/encoding';
import { HttpClient, HttpClientRequest, type HttpClientResponse } from 'effect/http';
import { HttpApiClient } from 'effect/http-api';
import { SqlClient } from 'effect/sql';
import { ApiRoutes, serve } from '../http/HttpLive.ts';
import { ProfilesRepo } from '../profiles/ProfilesRepo.ts';
import { SettingsRepo } from '../settings/SettingsRepo.ts';
import { Supervisor } from '../supervisor/Supervisor.ts';
import { ServerTest } from '../testing/http.ts';
import { chatStub, FAKE, freePort, pidAlive, until } from '../testing/llama.ts';
import { ServicesTest } from '../testing/services.ts';
import { ConversationsRepo } from './ConversationsRepo.ts';

/** The API as the app serves it, on a real server, with the services it uses for what a test checks behind it. */
const Served = serve(ApiRoutes).pipe(Layer.provideMerge(ServicesTest), Layer.provideMerge(ServerTest));

const parseJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';

const requestOf = (method: Method, path: string, body?: string) => {
  const base = HttpClientRequest.make(method)(path);
  return body === undefined ? base : HttpClientRequest.bodyText(base, body, 'application/json');
};

/** The status, the headers, the text and (when it is JSON) the value of a raw reply. */
const send = (method: Method, path: string, body?: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const res = yield* client.execute(requestOf(method, path, body));
    const text = yield* res.text;
    const isJson = Option.exists(Option.fromNullishOr(res.headers['content-type']), Str.startsWith('application/json'));
    const json: unknown = isJson && Str.isNonEmpty(text) ? yield* parseJson(text) : undefined;
    return { status: res.status, headers: res.headers, text, json };
  });

/** A JSON reply as the schema reads it: a reply of another shape fails the test. */
const as = <A, I>(schema: Schema.Codec<A, I>, json: unknown) => Schema.decodeUnknownEffect(schema)(json);

/** The JSON reply of a GET, as the schema reads it. */
const read = <A, I>(schema: Schema.Codec<A, I>, path: string) =>
  Effect.flatMap(send('GET', path), (reply) => as(schema, reply.json));

/** The body of a 400 `RequestInvalid`. */
const Refused = Schema.TaggedStruct('RequestInvalid', {
  message: Schema.String,
  issues: Schema.Array(Schema.Struct({ path: Schema.Array(Schema.String), message: Schema.String })),
});

/** The events of an event-stream reply, as the web reads them: each `ChatSseEvent` decoded. */
const eventsOf = (res: HttpClientResponse.HttpClientResponse) =>
  res.stream.pipe(Stream.decodeText, Stream.pipeThroughChannel(Sse.decodeSchema(ChatSseEvent)));

/**
 * A streamed reply read in a fiber, its request in the scope of the caller (closing it is a client that leaves): the
 * reply, the events so far, and a wait for the first `n`.
 */
const open = (method: Method, path: string, body?: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const res = yield* HttpClient.withScope(client).execute(requestOf(method, path, body));
    const events: Array<ChatEvent> = [];
    const fiber = yield* eventsOf(res).pipe(
      Stream.runForEach((event) => Effect.sync(() => events.push(event))),
      Effect.forkScoped,
    );
    return { res, events, fiber, got: (n: number) => until(() => events.length >= n) };
  });

/** A conversation with no profile; its id. */
const created = Effect.gen(function* () {
  const reply = yield* send('POST', '/api/chat', '{"profileId":null}');
  assert.strictEqual(reply.status, 201);
  return (yield* as(ConversationDetail, reply.json)).id;
});

/** A chat stub the supervisor takes for a llama-server started by hand, and a conversation without a profile. */
const external = Effect.gen(function* () {
  const llama = yield* chatStub;
  const supervisor = yield* Supervisor;
  const detected = yield* supervisor.detectExternal(llama.port);
  assert.isTrue(detected);
  const id = yield* created;
  return { llama, id };
});

const doneOf = (events: ReadonlyArray<ChatEvent>): ChatMessage => {
  const last = Arr.last(events);
  if (Option.isNone(last) || last.value.type !== 'done') return assert.fail('the reply did not end with done');
  return last.value.message;
};

const assistantOf = (id: number) =>
  Effect.gen(function* () {
    const repo = yield* ConversationsRepo;
    const messages = yield* repo.messages(id);
    return yield* Effect.fromOption(Arr.findLast(messages, (m) => m.role === 'assistant')).pipe(Effect.orDie);
  });

/** Waits until the supervisor is in `kind` (looked at every 10 ms, for 5 s at most). */
const stateWhen = (kind: ServerState['kind']) =>
  Effect.gen(function* () {
    const supervisor = yield* Supervisor;
    return yield* supervisor.state.pipe(
      Effect.repeat({ schedule: Schedule.spaced('10 millis'), until: (state) => state.kind === kind }),
      Effect.timeout('5 seconds'),
    );
  });

/** The fake llama-server on a profile of its own (model `/m/a.gguf`), started through the API: the profile and pid. */
const startFake = (env: Readonly<Record<string, string>> = {}) =>
  Effect.gen(function* () {
    const settings = yield* SettingsRepo;
    const profiles = yield* ProfilesRepo;
    yield* settings.patch({ binary: FAKE });
    const port = yield* freePort;
    const profile = yield* profiles.create({ name: 'A', model: '/m/a.gguf', port, args: [], env });
    const started = yield* send('POST', '/api/server/start', `{"profileId":${profile.id}}`);
    assert.strictEqual(started.status, 202);
    const ready = yield* stateWhen('ready');
    if (ready.kind !== 'ready') return assert.fail('llama-server is not ready');
    return { profile, pid: ready.pid };
  });

/** Stops the fake through the API and checks that it is gone. */
const stopFake = (pid: number) =>
  Effect.gen(function* () {
    const stopped = yield* send('POST', '/api/server/stop');
    assert.strictEqual(stopped.status, 200);
    yield* until(() => !pidAlive(pid));
  });

/** A detail without its messages and `live`: the conversation as stored. */
const storedOf = ({ messages: _messages, live: _live, ...conversation }: ConversationDetail) => conversation;

const types = (events: ReadonlyArray<ChatEvent>) => Arr.map(events, (e) => e.type);

describe('ChatApi', () => {
  layer(Served, { excludeTestServices: true, buildPerTest: true })('over HTTP', (it) => {
    it.effect(
      'POST /api/chat: profileId null records no profile, omitted the active one, a string is a 400 (#37)',
      () =>
        Effect.gen(function* () {
          const create = (body: string) => send('POST', '/api/chat', body);
          const idle = yield* as(ConversationDetail, (yield* create('{}')).json);
          assert.deepStrictEqual([idle.profileId, idle.modelPath], [null, null]);
          const { profile, pid } = yield* startFake();
          const none = yield* create('{"profileId":null}');
          assert.strictEqual(none.status, 201);
          assert.isNull((yield* as(ConversationDetail, none.json)).profileId);
          const active = yield* as(ConversationDetail, (yield* create('{}')).json);
          assert.deepStrictEqual([active.profileId, active.modelPath], [profile.id, '/m/a.gguf']);
          assert.deepStrictEqual([active.title, active.messages, active.live], ['New conversation', [], false]);
          const named = yield* as(ConversationDetail, (yield* create(`{"profileId":${profile.id}}`)).json);
          assert.strictEqual(named.profileId, profile.id);
          const text = yield* create(`{"profileId":"${profile.id}"}`);
          assert.strictEqual(text.status, 400);
          assert.strictEqual((yield* as(Refused, text.json))._tag, 'RequestInvalid');
          const missing = yield* create('{"profileId":999}');
          assert.deepStrictEqual(
            [missing.status, missing.json],
            [404, { _tag: 'ProfileNotFound', message: 'Profile not found' }],
          );
          yield* stopFake(pid);
        }),
    );

    it.effect(
      'GET /api/chat/:id/stream is a 404 for a conversation that does not exist, a 204 without a reply (#37)',
      () =>
        Effect.gen(function* () {
          const missing = yield* send('GET', '/api/chat/42/stream');
          assert.deepStrictEqual(
            [missing.status, missing.json],
            [404, { _tag: 'ConversationNotFound', message: 'Conversation not found' }],
          );
          const id = yield* created;
          const none = yield* send('GET', `/api/chat/${id}/stream`);
          assert.deepStrictEqual([none.status, none.text], [204, '']);
        }),
    );

    it.effect('GET /api/chat/:id/stream sends the run as SSE events and ends after done', () =>
      Effect.gen(function* () {
        const { llama, id } = yield* external;
        const sent = yield* open('POST', `/api/chat/${id}/messages`, '{"content":"Hi"}');
        yield* llama.requested(1);
        yield* llama.chunk({ content: 'h' });
        yield* sent.got(2);
        const followed = yield* open('GET', `/api/chat/${id}/stream`);
        assert.strictEqual(followed.res.status, 200);
        assert.strictEqual(followed.res.headers['content-type'], 'text/event-stream');
        assert.include(followed.res.headers['cache-control'], 'no-cache');
        // The replay (the start and what was written), then the live deltas.
        yield* followed.got(2);
        yield* llama.chunk({ content: 'i' });
        yield* followed.got(3);
        yield* llama.done;
        yield* Fiber.join(followed.fiber);
        assert.deepStrictEqual(types(followed.events), ['start', 'delta', 'delta', 'done']);
        assert.deepStrictEqual(Arr.drop(Arr.take(followed.events, 3), 1), [
          { type: 'delta', content: 'h' },
          { type: 'delta', content: 'i' },
        ]);
        const message = doneOf(followed.events);
        assert.deepStrictEqual([message.status, message.content], ['done', 'hi']);
        yield* Fiber.join(sent.fiber);
        assert.deepStrictEqual(doneOf(sent.events), message);
      }),
    );

    it.effect('GET /api/chat/:id/stream: a client that leaves only unsubscribes', () =>
      Effect.gen(function* () {
        const { llama, id } = yield* external;
        const sent = yield* open('POST', `/api/chat/${id}/messages`, '{"content":"Hi"}');
        yield* llama.requested(1);
        const scope = yield* Scope.make();
        const followed = yield* open('GET', `/api/chat/${id}/stream`).pipe(Scope.provide(scope));
        yield* followed.got(1);
        yield* Scope.close(scope, Exit.void);
        yield* llama.chunk({ content: 'Hello' });
        yield* llama.done;
        yield* Fiber.join(sent.fiber);
        assert.deepStrictEqual(types(followed.events), ['start']);
        const message = doneOf(sent.events);
        assert.deepStrictEqual([message.status, message.content], ['done', 'Hello']);
        assert.strictEqual(llama.aborted(), 0);
      }),
    );

    it.effect('a client that leaves only unsubscribes, and the reply is followed again by stream', () =>
      Effect.gen(function* () {
        const { llama, id } = yield* external;
        const scope = yield* Scope.make();
        const sent = yield* open('POST', `/api/chat/${id}/messages`, '{"content":"Hi"}').pipe(Scope.provide(scope));
        yield* llama.requested(1);
        yield* llama.chunk({ content: 'Hello' });
        yield* sent.got(2);
        yield* Scope.close(scope, Exit.void);
        yield* llama.chunk({ content: ' world' });
        const detail = yield* read(ConversationDetail, `/api/chat/${id}`);
        assert.isTrue(detail.live);
        const again = yield* open('GET', `/api/chat/${id}/stream`);
        yield* again.got(2);
        yield* llama.chunk({ content: '!' });
        yield* llama.done;
        yield* Fiber.join(again.fiber);
        assert.deepStrictEqual(Arr.take(again.events, 2)[1], { type: 'delta', content: 'Hello world' });
        assert.deepStrictEqual(types(again.events), ['start', 'delta', 'delta', 'done']);
        assert.deepStrictEqual(types(sent.events), ['start', 'delta']);
        const message = doneOf(again.events);
        assert.deepStrictEqual([message.status, message.content], ['done', 'Hello world!']);
        assert.strictEqual(llama.aborted(), 0);
      }),
    );

    it.effect('a reply is an event stream with the headers of the Nitro server', () =>
      Effect.gen(function* () {
        const { llama, id } = yield* external;
        const sent = yield* open('POST', `/api/chat/${id}/messages`, '{"content":"Hi"}');
        assert.strictEqual(sent.res.status, 200);
        assert.deepStrictEqual(
          [
            sent.res.headers['content-type'],
            sent.res.headers['cache-control'],
            sent.res.headers.connection,
            sent.res.headers['x-accel-buffering'],
          ],
          ['text/event-stream', 'private, no-cache, no-store, no-transform, must-revalidate, max-age=0', 'close', 'no'],
        );
        yield* llama.requested(1);
        yield* llama.done;
        yield* Fiber.join(sent.fiber);
        assert.deepStrictEqual(types(sent.events), ['start', 'done']);
      }),
    );

    it.effect('stop answers 204 and the reply is saved stopped', () =>
      Effect.gen(function* () {
        const { llama, id } = yield* external;
        const sent = yield* open('POST', `/api/chat/${id}/messages`, '{"content":"Hi"}');
        yield* llama.requested(1);
        yield* llama.chunk({ content: 'Hel' });
        yield* sent.got(2);
        const stopped = yield* send('POST', `/api/chat/${id}/stop`);
        assert.deepStrictEqual([stopped.status, stopped.text], [204, '']);
        yield* Fiber.join(sent.fiber);
        const message = doneOf(sent.events);
        assert.deepStrictEqual([message.status, message.content], ['stopped', 'Hel']);
        const saved = yield* assistantOf(id);
        assert.deepStrictEqual([saved.status, saved.content], ['stopped', 'Hel']);
        yield* until(() => llama.aborted() === 1);
        const again = yield* send('POST', `/api/chat/${id}/stop`);
        assert.deepStrictEqual(
          [again.status, again.json],
          [409, { _tag: 'NoReplyInProgress', message: 'No reply in progress' }],
        );
      }),
    );

    it.effect('live is true in the list and the detail while a reply runs', () =>
      Effect.gen(function* () {
        const { llama, id } = yield* external;
        const other = yield* created;
        const liveOf = Effect.gen(function* () {
          const list = yield* read(Schema.Array(ConversationSummary), '/api/chat');
          const detail = yield* read(ConversationDetail, `/api/chat/${id}`);
          const line = (n: number) => Arr.findFirst(list, (c) => c.id === n).pipe(Option.map((c) => c.live));
          return [line(id), line(other), detail.live];
        });
        const before = yield* liveOf;
        assert.deepStrictEqual(before, [Option.some(false), Option.some(false), false]);
        const sent = yield* open('POST', `/api/chat/${id}/messages`, '{"content":"Hi"}');
        yield* llama.requested(1);
        const during = yield* liveOf;
        assert.deepStrictEqual(during, [Option.some(true), Option.some(false), true]);
        yield* llama.done;
        yield* Fiber.join(sent.fiber);
        const after = yield* liveOf;
        assert.deepStrictEqual(after, [Option.some(false), Option.some(false), false]);
        const list = yield* read(Schema.Array(ConversationSummary), '/api/chat');
        // The conversation that got a reply is the most recently updated, titled from its first message.
        assert.deepStrictEqual(
          Arr.map(list, (c) => [c.id, c.title, c.messageCount]),
          [
            [id, 'Hi', 2],
            [other, 'New conversation', 0],
          ],
        );
      }),
    );

    it.effect('deleting a conversation during a reply stops it and deletes its messages', () =>
      Effect.gen(function* () {
        const { llama, id } = yield* external;
        const sql = yield* SqlClient.SqlClient;
        const sent = yield* open('POST', `/api/chat/${id}/messages`, '{"content":"Hi"}');
        yield* llama.requested(1);
        yield* llama.chunk({ content: 'Hel' });
        yield* sent.got(2);
        const removed = yield* send('DELETE', `/api/chat/${id}`);
        assert.deepStrictEqual([removed.status, removed.text], [204, '']);
        // The stop was saved before the conversation went: the client's stream ends with it.
        yield* Fiber.join(sent.fiber);
        const message = doneOf(sent.events);
        assert.deepStrictEqual([message.status, message.content], ['stopped', 'Hel']);
        const gone = yield* send('GET', `/api/chat/${id}`);
        assert.strictEqual(gone.status, 404);
        const rows = yield* sql<{ n: number }>`SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ${id}`;
        assert.deepStrictEqual(rows, [{ n: 0 }]);
        yield* until(() => llama.aborted() === 1);
        const again = yield* send('DELETE', `/api/chat/${id}`);
        assert.strictEqual(again.status, 404);
      }),
    );

    it.effect('a second send while a reply runs is a 409, a regeneration with no user message 409', () =>
      Effect.gen(function* () {
        const { llama, id } = yield* external;
        const nothing = yield* send('POST', `/api/chat/${id}/regenerate`);
        assert.deepStrictEqual(
          [nothing.status, nothing.json],
          [409, { _tag: 'NothingToRegenerate', message: 'Nothing to regenerate' }],
        );
        const blank = yield* send('POST', `/api/chat/${id}/messages`, '{"content":"   "}');
        assert.deepStrictEqual([blank.status, blank.json], [400, { _tag: 'EmptyMessage', message: 'Empty message' }]);
        const sent = yield* open('POST', `/api/chat/${id}/messages`, '{"content":"Hi"}');
        yield* llama.requested(1);
        const busy = { _tag: 'ReplyInProgress', message: 'A reply is already in progress in this conversation' };
        const second = yield* send('POST', `/api/chat/${id}/messages`, '{"content":"Again"}');
        assert.deepStrictEqual([second.status, second.json], [409, busy]);
        const regenerating = yield* send('POST', `/api/chat/${id}/regenerate`);
        assert.deepStrictEqual([regenerating.status, regenerating.json], [409, busy]);
        yield* llama.chunk({ content: 'One' });
        yield* llama.done;
        yield* Fiber.join(sent.fiber);
        // A regeneration replaces the reply.
        const regenerated = yield* open('POST', `/api/chat/${id}/regenerate`);
        yield* llama.requested(2);
        yield* llama.chunk({ content: 'Two' });
        yield* llama.done;
        yield* Fiber.join(regenerated.fiber);
        const start = Arr.head(regenerated.events);
        assert.isTrue(Option.exists(start, (e) => e.type === 'start' && e.user === null));
        assert.strictEqual(doneOf(regenerated.events).content, 'Two');
        const detail = yield* read(ConversationDetail, `/api/chat/${id}`);
        assert.deepStrictEqual(
          Arr.map(detail.messages, (m) => [m.role, m.content]),
          [
            ['user', 'Hi'],
            ['assistant', 'Two'],
          ],
        );
      }),
    );

    it.effect('send answers 409 llama-server is not ready without a server', () =>
      Effect.gen(function* () {
        const id = yield* created;
        const refused = { _tag: 'ServerNotReady', message: 'llama-server is not ready' };
        const sent = yield* send('POST', `/api/chat/${id}/messages`, '{"content":"Hi"}');
        assert.deepStrictEqual([sent.status, sent.json], [409, refused]);
        const regenerated = yield* send('POST', `/api/chat/${id}/regenerate`);
        assert.deepStrictEqual([regenerated.status, regenerated.json], [409, refused]);
        const detail = yield* read(ConversationDetail, `/api/chat/${id}`);
        assert.deepStrictEqual(detail.messages, []);
      }),
    );

    it.effect('a successful PATCH stores the fields and answers the detail', () =>
      Effect.gen(function* () {
        const repo = yield* ConversationsRepo;
        const id = yield* created;
        const before = yield* repo.get(id);
        const patched = yield* send(
          'PATCH',
          `/api/chat/${id}`,
          '{"title":"  Renamed  ","systemPrompt":"Be brief.","sampling":{"temperature":0.5,"top_k":40},"thinking":false}',
        );
        assert.strictEqual(patched.status, 200);
        const detail = yield* as(ConversationDetail, patched.json);
        assert.deepStrictEqual(
          [
            detail.id,
            detail.title,
            detail.systemPrompt,
            detail.sampling,
            detail.thinking,
            detail.messages,
            detail.live,
          ],
          [id, 'Renamed', 'Be brief.', { temperature: 0.5, top_k: 40 }, false, [], false],
        );
        assert.isAtLeast(detail.updatedAt, before.updatedAt);
        const stored = yield* repo.get(id);
        assert.deepStrictEqual(stored, storedOf(detail));
        const again = yield* read(ConversationDetail, `/api/chat/${id}`);
        assert.deepStrictEqual(again, detail);
      }),
    );

    it.effect('the requests are strict: a field of the wrong type or an unknown key is a 400 RequestInvalid', () =>
      Effect.gen(function* () {
        const id = yield* created;
        const refused = (method: Method, path: string, body: string) =>
          Effect.gen(function* () {
            const reply = yield* send(method, path, body);
            assert.strictEqual(reply.status, 400, `${method} ${path} ${body}`);
            return yield* as(Refused, reply.json);
          });
        const messages = (r: typeof Refused.Type) => Arr.map(r.issues, (i) => [i.path, i.message]);
        yield* refused('POST', '/api/chat', '{"profileId":1.5}');
        yield* refused('POST', '/api/chat', '{"other":1}');
        yield* refused('POST', `/api/chat/${id}/messages`, '{"content":5}');
        yield* refused('POST', `/api/chat/${id}/messages`, '{}');
        const unknown = yield* refused('PATCH', `/api/chat/${id}`, '{"nope":1}');
        assert.deepStrictEqual(messages(unknown), [[['nope'], 'unknown key']]);
        yield* refused('PATCH', `/api/chat/${id}`, '{"title":5}');
        const blank = yield* refused('PATCH', `/api/chat/${id}`, '{"title":"   "}');
        assert.deepStrictEqual(messages(blank), [[['title'], 'Required']]);
        const hot = yield* refused('PATCH', `/api/chat/${id}`, '{"sampling":{"temperature":6}}');
        assert.deepStrictEqual(messages(hot), [[['sampling', 'temperature'], 'Temperature: between 0 and 5']]);
        const notAnId = yield* send('GET', '/api/chat/abc');
        assert.strictEqual(notAnId.status, 404);
        const unchanged = yield* read(ConversationDetail, `/api/chat/${id}`);
        assert.strictEqual(unchanged.title, 'New conversation');
      }),
    );

    it.effect('each endpoint of a conversation that does not exist is a 404, a stop of one a 409', () =>
      Effect.gen(function* () {
        const notFound = { _tag: 'ConversationNotFound', message: 'Conversation not found' };
        const requests: ReadonlyArray<readonly [Method, string, string?]> = [
          ['GET', '/api/chat/999'],
          ['PATCH', '/api/chat/999', '{"title":"x"}'],
          ['DELETE', '/api/chat/999'],
          ['POST', '/api/chat/999/messages', '{"content":"Hi"}'],
          ['POST', '/api/chat/999/regenerate'],
          ['GET', '/api/chat/999/stream'],
        ];
        for (const [method, path, body] of requests) {
          const reply = yield* send(method, path, body);
          assert.deepStrictEqual([reply.status, reply.json], [404, notFound], `${method} ${path}`);
        }
        const stop = yield* send('POST', '/api/chat/999/stop');
        assert.deepStrictEqual(
          [stop.status, stop.json],
          [409, { _tag: 'NoReplyInProgress', message: 'No reply in progress' }],
        );
      }),
    );

    it.effect('the typed client decodes a reply of llama-server, started by the supervisor, into its events', () =>
      Effect.gen(function* () {
        const { pid } = yield* startFake({ FAKE_CHAT_DELAY_MS: '0' });
        const client = yield* HttpApiClient.make(Api);
        const conversation = yield* client.chat.create({ payload: {} });
        const reply = yield* client.chat.send({ params: { id: conversation.id }, payload: { content: 'Hi' } });
        const events = yield* Stream.runCollect(reply).pipe(Effect.map(Arr.fromIterable));
        const kinds = types(events);
        assert.strictEqual(Arr.head(kinds).pipe(Option.getOrNull), 'start');
        assert.isTrue(Arr.every(Arr.drop(Arr.dropRight(kinds, 1), 1), (k) => k === 'delta'));
        assert.isAbove(kinds.length, 3);
        const message = doneOf(events);
        assert.deepStrictEqual([message.status, message.model], ['done', '/m/a.gguf']);
        assert.isTrue(Str.isNonEmpty(message.content));
        assert.isTrue(Str.isNonEmpty(message.reasoning));
        assert.strictEqual(message.stats?.promptTokens, 42);
        const none = yield* client.chat.follow({ params: { id: conversation.id } });
        assert.isUndefined(none);
        const refused = yield* Effect.flip(client.chat.stop({ params: { id: conversation.id } }));
        assert.strictEqual(refused._tag, 'NoReplyInProgress');
        yield* stopFake(pid);
      }),
    );
  });
});
