import { assert, layer } from '@effect/vitest';
import { type ChatEvent, type ChatMessage, DEFAULT_SETTINGS, DEFAULT_TITLE } from '@llama-webui/shared';
import {
  Array as Arr,
  Context,
  type Duration,
  Effect,
  Fiber,
  Layer,
  Option,
  Path,
  Ref,
  Result,
  Schedule,
  Stream,
} from 'effect';
import { TestClock } from 'effect/testing';
import { ProfilesRepo } from '../profiles/ProfilesRepo.ts';
import { Shutdown } from '../runtime/Shutdown.ts';
import { buildCommand } from '../supervisor/command.ts';
import { Supervisor } from '../supervisor/Supervisor.ts';
import { chatStub, FAKE, freePort, httpStub, pidAlive, type Stub, until } from '../testing/llama.ts';
import { ServicesTest } from '../testing/services.ts';
import { type ChatReply, ChatRuns } from './ChatRuns.ts';
import { ConversationsRepo } from './ConversationsRepo.ts';
import type { ChatTarget } from './target.ts';

/** The services, the conversations on their database among them; each test builds the replies it tries. */
const Base = ServicesTest;

const TIMINGS = { prompt_n: 10, prompt_per_second: 200, predicted_n: 3, predicted_per_second: 51.23 };
const CUT = 'llama-server cut the reply short (stopped or crashed)';

/** The replies, built in the test's scope: they write every delta unless told otherwise. */
const runsWith = (options: {
  readonly flushInterval?: Duration.Input;
  readonly target?: Effect.Effect<Option.Option<ChatTarget>>;
}) =>
  Layer.build(
    ChatRuns.layerWith({
      flushInterval: options.flushInterval ?? 0,
      ...(options.target === undefined ? {} : { target: options.target }),
    }),
  ).pipe(Effect.map((context) => Context.get(context, ChatRuns)));

/** The managed server a profile-less reply is asked of: the stub, with a model. */
const targetOf = (stub: Stub): ChatTarget => ({
  host: '127.0.0.1',
  port: stub.port,
  profileId: null,
  modelPath: '/m.gguf',
});

/**
 * A chat stub, a conversation on `/m.gguf`, and the replies asked of the stub (its target found after `targetDelay`,
 * none by default).
 */
const setup = (options: { readonly flushInterval?: Duration.Input; readonly targetDelay?: Duration.Input } = {}) =>
  Effect.gen(function* () {
    const llama = yield* chatStub;
    const repo = yield* ConversationsRepo;
    const conv = yield* repo.create({ profileId: null, modelPath: '/m.gguf' });
    const target = Effect.succeedSome(targetOf(llama)).pipe(Effect.delay(options.targetDelay ?? 0));
    const runs = yield* runsWith({
      ...(options.flushInterval === undefined ? {} : { flushInterval: options.flushInterval }),
      target,
    });
    return { llama, repo, conv, runs };
  });

/** Follows the events of `reply` in a fiber of the test: what came so far, and a wait for the first `n`. */
const follow = (reply: ChatReply) =>
  Effect.gen(function* () {
    const events: Array<ChatEvent> = [];
    const fiber = yield* reply.events.pipe(
      Stream.runForEach((event) => Effect.sync(() => events.push(event))),
      Effect.forkScoped,
    );
    return { events, fiber, got: (n: number) => until(() => events.length >= n) };
  });

/** Every event of `reply` until its `done`, in a fiber: joined once the reply ended. */
const toEnd = (reply: ChatReply) => Effect.forkScoped(Stream.runCollect(reply.events));

/** The `done` message of the events `end` collected, once the reply ended. */
const doneAt = <E>(end: Fiber.Fiber<ReadonlyArray<ChatEvent>, E>) => Effect.map(Fiber.join(end), doneOf);

const assistantOf = (repo: ConversationsRepo['Service'], id: number) =>
  repo.messages(id).pipe(
    Effect.map((messages) => Arr.findLast(messages, (m) => m.role === 'assistant')),
    Effect.flatMap(Effect.fromOption),
    Effect.orDie,
  );

const doneOf = (events: ReadonlyArray<ChatEvent>): ChatMessage => {
  const last = Arr.last(events);
  if (Option.isNone(last) || last.value.type !== 'done') return assert.fail('the reply did not end with done');
  return last.value.message;
};

/** No run of `id` is left. */
const noRunLeft = (runs: ChatRuns['Service'], id: number) =>
  Effect.gen(function* () {
    const live = yield* runs.isLive(id);
    const reply = yield* runs.live(id);
    assert.isFalse(live);
    assert.isTrue(Option.isNone(reply));
  });

layer(Base, { excludeTestServices: true, buildPerTest: true })('ChatRuns', (it) => {
  it.effect('a run keeps going and is saved when its listener leaves', () =>
    Effect.gen(function* () {
      const { llama, repo, conv, runs } = yield* setup();
      const reply = yield* runs.send(conv.id, 'Hi there');
      const end = yield* toEnd(reply);
      const listener = yield* follow(reply);
      yield* llama.requested(1);
      yield* llama.chunk({ reasoning_content: 'Hmm.' });
      yield* listener.got(2);
      yield* Fiber.interrupt(listener.fiber);
      yield* llama.chunk({ content: 'Hello' });
      yield* llama.chunk({ content: '!' });
      yield* llama.chunk({}, { timings: TIMINGS });
      yield* llama.done;
      yield* Fiber.join(end);
      assert.deepStrictEqual(
        Arr.map(listener.events, (e) => e.type),
        ['start', 'delta'],
      );
      const a = yield* assistantOf(repo, conv.id);
      assert.deepStrictEqual([a.status, a.content, a.reasoning], ['done', 'Hello!', 'Hmm.']);
      assert.strictEqual(a.stats?.tgTps, 51.23);
      assert.isNotNull(a.stats?.ttftMs ?? null);
      assert.strictEqual((yield* repo.get(conv.id)).title, 'Hi there');
      yield* noRunLeft(runs, conv.id);
    }),
  );

  it.effect('stop saves the partial answer as stopped', () =>
    Effect.gen(function* () {
      const { llama, repo, conv, runs } = yield* setup();
      const reply = yield* runs.send(conv.id, 'Hi');
      const end = yield* toEnd(reply);
      const listener = yield* follow(reply);
      yield* llama.requested(1);
      yield* llama.chunk({ content: 'Hel' });
      yield* listener.got(2);
      yield* runs.stop(conv.id);
      const done = yield* doneAt(end);
      assert.deepStrictEqual([done.status, done.content], ['stopped', 'Hel']);
      const a = yield* assistantOf(repo, conv.id);
      assert.deepStrictEqual([a.status, a.content], ['stopped', 'Hel']);
      // The request was aborted.
      yield* until(() => llama.aborted() === 1);
      yield* noRunLeft(runs, conv.id);
    }),
  );

  it.effect('a late subscriber gets what was already written', () =>
    Effect.gen(function* () {
      const { llama, conv, runs } = yield* setup();
      const reply = yield* runs.send(conv.id, 'Hi');
      const early = yield* follow(reply);
      yield* llama.requested(1);
      yield* llama.chunk({ content: 'Hel' });
      yield* llama.chunk({ content: 'lo' });
      yield* early.got(3);
      const live = yield* runs.live(conv.id);
      assert.isTrue(Option.isSome(live));
      if (Option.isNone(live)) return;
      const late = yield* follow(live.value);
      yield* late.got(2);
      yield* llama.chunk({ content: '!' });
      yield* llama.done;
      yield* late.got(4);
      const [start, ...rest] = late.events;
      assert.strictEqual(start?.type, 'start');
      assert.deepStrictEqual(Arr.take(rest, 2), [
        { type: 'delta', content: 'Hello' },
        { type: 'delta', content: '!' },
      ]);
      assert.strictEqual(doneOf(late.events).content, 'Hello!');
      // Once the reply ended, a subscriber gets its start, what it wrote and its done at once.
      const after = yield* Stream.runCollect(reply.events);
      assert.deepStrictEqual(
        Arr.map(after, (e) => e.type),
        ['start', 'delta', 'done'],
      );
      yield* noRunLeft(runs, conv.id);
    }),
  );

  it.effect('a stream that ends without [DONE] or breaks is an error that keeps the partial answer', () =>
    Effect.gen(function* () {
      const { llama, repo, conv, runs } = yield* setup();
      const reply = yield* runs.send(conv.id, 'Hi');
      const end = yield* toEnd(reply);
      yield* llama.requested(1);
      yield* llama.chunk({ content: 'Hel' });
      yield* llama.end;
      yield* Fiber.join(end);
      const a = yield* assistantOf(repo, conv.id);
      assert.deepStrictEqual([a.status, a.content, a.error], ['error', 'Hel', CUT]);
      yield* noRunLeft(runs, conv.id);
    }),
  );

  it.effect('dispose emits done(stopped) to listeners, so their streams close', () =>
    Effect.gen(function* () {
      const { llama, repo, conv, runs } = yield* setup();
      const shutdown = yield* Shutdown;
      const reply = yield* runs.send(conv.id, 'Hi');
      const end = yield* toEnd(reply);
      const listener = yield* follow(reply);
      yield* llama.requested(1);
      // Timings the run would save as stats, were it to write after the shutdown step.
      yield* llama.chunk({ content: 'Hel' }, { timings: TIMINGS });
      yield* listener.got(2);
      yield* shutdown.run;
      const done = yield* doneAt(end);
      assert.deepStrictEqual([done.status, done.content], ['stopped', 'Hel']);
      assert.deepStrictEqual(doneOf(listener.events), done);
      yield* runs.stopAndWait(conv.id);
      const a = yield* assistantOf(repo, conv.id);
      assert.deepStrictEqual([a.status, a.content, a.stats], ['stopped', 'Hel', null]);
      yield* until(() => llama.aborted() === 1);
      yield* noRunLeft(runs, conv.id);
    }),
  );

  it.effect('stopAndWait returns once the reply is saved stopped, after a start in flight', () =>
    Effect.gen(function* () {
      const { llama, repo, conv, runs } = yield* setup({ targetDelay: '50 millis' });
      const reply = yield* runs.send(conv.id, 'Hi');
      const listener = yield* follow(reply);
      yield* llama.requested(1);
      yield* llama.chunk({ content: 'Hel' });
      yield* listener.got(2);
      // No shutdown first: as the delete of a conversation does.
      yield* runs.stopAndWait(conv.id);
      const a = yield* assistantOf(repo, conv.id);
      assert.deepStrictEqual([a.status, a.content], ['stopped', 'Hel']);
      yield* noRunLeft(runs, conv.id);

      // A send still waiting for its target holds the runs' lock: stopAndWait queues behind it and stops its reply.
      const other = yield* repo.create({ profileId: null, modelPath: null });
      const sending = yield* Effect.forkChild(runs.send(other.id, 'Hi'), { startImmediately: true });
      yield* runs.stopAndWait(other.id);
      yield* Fiber.join(sending);
      const stopped = yield* assistantOf(repo, other.id);
      assert.deepStrictEqual([stopped.status, stopped.content], ['stopped', '']);
      yield* noRunLeft(runs, other.id);
    }),
  );

  it.effect('two sends at once give one reply and one 409', () =>
    Effect.gen(function* () {
      // The target answers late: were the check and the registration two steps, both sends would pass the check.
      const { llama, repo, conv, runs } = yield* setup({ targetDelay: '20 millis' });
      const both = yield* Effect.all(
        [Effect.result(runs.send(conv.id, 'One')), Effect.result(runs.send(conv.id, 'Two'))],
        {
          concurrency: 2,
        },
      );
      const replies = Arr.filter(both, Result.isSuccess);
      const refused = Arr.filterMap(both, (r) => (Result.isFailure(r) ? Result.succeed(r.failure) : Result.failVoid));
      assert.strictEqual(replies.length, 1);
      assert.deepStrictEqual(
        Arr.map(refused, (e) => [e._tag, e.message]),
        [['ReplyInProgress', 'A reply is already in progress in this conversation']],
      );
      const [reply] = replies;
      if (reply === undefined) return;
      const end = yield* toEnd(reply.success);
      yield* llama.requested(1);
      yield* llama.chunk({ content: 'Yes' });
      yield* llama.done;
      yield* Fiber.join(end);
      const messages = yield* repo.messages(conv.id);
      assert.deepStrictEqual(
        Arr.map(messages, (m) => [m.role, m.status]),
        [
          ['user', 'done'],
          ['assistant', 'done'],
        ],
      );
      assert.strictEqual(llama.bodies().length, 1);
      yield* noRunLeft(runs, conv.id);
    }),
  );

  it.effect(
    'a stream cut short is an error that keeps the partial answer, and the conversation takes a new message',
    () =>
      Effect.gen(function* () {
        const { llama, repo, conv, runs } = yield* setup();
        const first = yield* runs.send(conv.id, 'Hi');
        const firstEnd = yield* toEnd(first);
        const listener = yield* follow(first);
        yield* llama.requested(1);
        yield* llama.chunk({ content: 'Hel' });
        yield* listener.got(2);
        yield* llama.cut;
        const failed = yield* doneAt(firstEnd);
        assert.deepStrictEqual([failed.status, failed.content, failed.error], ['error', 'Hel', CUT]);
        yield* noRunLeft(runs, conv.id);

        const second = yield* runs.send(conv.id, 'Again');
        const secondEnd = yield* toEnd(second);
        yield* llama.requested(2);
        // The failed reply is not sent; the two user messages in a row are one turn.
        assert.deepStrictEqual(
          Option.map(Arr.get(llama.bodies(), 1), (body) => (body as { messages: unknown }).messages),
          Option.some([{ role: 'user', content: 'Hi\n\nAgain' }]),
        );
        yield* llama.chunk({ content: 'Yes' });
        yield* llama.done;
        yield* Fiber.join(secondEnd);
        const messages = yield* repo.messages(conv.id);
        assert.deepStrictEqual(
          Arr.map(messages, (m) => [m.role, m.status, m.content]),
          [
            ['user', 'done', 'Hi'],
            ['assistant', 'error', 'Hel'],
            ['user', 'done', 'Again'],
            ['assistant', 'done', 'Yes'],
          ],
        );
        yield* noRunLeft(runs, conv.id);
      }),
  );

  it.effect('an HTTP error, a stream error event and an unreachable server are worded for the conversation', () =>
    Effect.gen(function* () {
      const repo = yield* ConversationsRepo;
      const refusing = yield* httpStub((_req, res) => {
        res
          .writeHead(400, { 'content-type': 'application/json' })
          .end('{"error":{"code":400,"message":"bad request","type":"invalid_request_error"}}');
      });
      const loading = yield* httpStub((_req, res) => {
        res.writeHead(503, { 'content-type': 'text/plain' }).end('loading');
      });
      const failing = yield* httpStub((_req, res) => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('data: {"choices":[{"index":0,"delta":{"content":"Par"}}]}\n\n');
        res.write('data: {"error":{"code":500,"message":"boom","type":"server_error"}}\n\n');
      });
      const nobody = yield* freePort;
      const target = yield* Ref.make<Option.Option<ChatTarget>>(Option.none());
      const runs = yield* runsWith({ target: Ref.get(target) });
      const replyOn = (port: number) =>
        Effect.gen(function* () {
          yield* Ref.set(target, Option.some({ host: null, port, profileId: null, modelPath: null }));
          const conv = yield* repo.create({ profileId: null, modelPath: null });
          const reply = yield* runs.send(conv.id, 'Hi');
          const events = yield* Stream.runCollect(reply.events);
          const done = doneOf(events);
          yield* noRunLeft(runs, conv.id);
          return [done.status, done.content, done.error];
        });
      const refused = yield* replyOn(refusing.port);
      const unavailable = yield* replyOn(loading.port);
      const broken = yield* replyOn(failing.port);
      assert.deepStrictEqual(refused, ['error', '', 'llama-server: bad request']);
      assert.deepStrictEqual(unavailable, ['error', '', 'llama-server: HTTP 503 — loading']);
      assert.deepStrictEqual(broken, ['error', 'Par', 'llama-server: boom']);
      const [status, content, error] = yield* replyOn(nobody);
      assert.deepStrictEqual([status, content], ['error', '']);
      assert.match(error ?? '', /^llama-server unreachable: .*ECONNREFUSED/);
    }),
  );

  it.effect("the first reply of a conversation without a model takes the target's", () =>
    Effect.gen(function* () {
      const repo = yield* ConversationsRepo;
      const profiles = yield* ProfilesRepo;
      const supervisor = yield* Supervisor;
      const path = yield* Path.Path;
      const port = yield* freePort;
      const profile = yield* profiles.create({
        name: 'fake',
        model: 'm.gguf',
        port,
        args: [],
        env: { FAKE_CHAT_DELAY_MS: '0' },
      });
      const cmd = yield* buildCommand({ profile, settings: { ...DEFAULT_SETTINGS, binary: FAKE, host: '127.0.0.1' } });
      yield* supervisor.start(cmd);
      const ready = yield* supervisor.state.pipe(
        Effect.repeat({ schedule: Schedule.spaced('10 millis'), until: (state) => state.kind === 'ready' }),
        Effect.timeout('5 seconds'),
      );
      const pid = ready.kind === 'ready' ? ready.pid : assert.fail('not ready');
      // The target is the managed server, as `ChatRuns.layer` finds it.
      const runs = yield* runsWith({});
      const conv = yield* repo.create({ profileId: null, modelPath: null });
      const model = path.resolve('m.gguf');
      const events = yield* Stream.runCollect((yield* runs.send(conv.id, 'Hi')).events);
      const [start] = events;
      assert.strictEqual(start?.type === 'start' ? start.assistant.model : null, model);
      const done = doneOf(events);
      assert.deepStrictEqual([done.status, done.model, done.stats?.tgTps], ['done', model, 51.2]);
      assert.isTrue(done.content.length > 0);
      const after = yield* repo.get(conv.id);
      assert.deepStrictEqual([after.profileId, after.modelPath], [profile.id, model]);
      // A conversation that has a model keeps it.
      const other = yield* repo.create({ profileId: null, modelPath: '/other.gguf' });
      yield* Stream.runDrain((yield* runs.send(other.id, 'Hi')).events);
      const kept = yield* repo.get(other.id);
      assert.deepStrictEqual([kept.profileId, kept.modelPath], [null, '/other.gguf']);
      assert.strictEqual((yield* assistantOf(repo, other.id)).model, model);
      yield* noRunLeft(runs, conv.id);
      yield* noRunLeft(runs, other.id);
      yield* supervisor.stop;
      assert.isFalse(pidAlive(pid));
    }),
  );

  it.effect('a reply against an external server has no profile and no model', () =>
    Effect.gen(function* () {
      const llama = yield* chatStub;
      const repo = yield* ConversationsRepo;
      const supervisor = yield* Supervisor;
      const external = yield* supervisor.detectExternal(llama.port);
      assert.isTrue(external);
      const runs = yield* runsWith({});
      const conv = yield* repo.create({ profileId: null, modelPath: null });
      const reply = yield* runs.send(conv.id, 'Hi');
      const end = yield* toEnd(reply);
      yield* llama.requested(1);
      yield* llama.chunk({ content: 'Yes' });
      yield* llama.done;
      const events = yield* Fiber.join(end);
      const [start] = events;
      assert.strictEqual(start?.type === 'start' ? start.assistant.model : 'no start', null);
      assert.deepStrictEqual([doneOf(events).content, doneOf(events).model], ['Yes', null]);
      const after = yield* repo.get(conv.id);
      assert.deepStrictEqual([after.profileId, after.modelPath], [null, null]);
      yield* noRunLeft(runs, conv.id);
    }),
  );

  it.effect('the auto-title is given on the first user message only', () =>
    Effect.gen(function* () {
      const { llama, repo, conv, runs } = yield* setup();
      const answer = (id: number, text: string, n: number) =>
        Effect.gen(function* () {
          const reply = yield* runs.send(id, text);
          const end = yield* toEnd(reply);
          yield* llama.requested(n);
          yield* llama.done;
          yield* Fiber.join(end);
        });
      yield* answer(conv.id, 'Tell me about the seven wonders of the world', 1);
      assert.strictEqual((yield* repo.get(conv.id)).title, 'Tell me about the seven wonders…');
      // Back to the default title, a second message does not rename it.
      yield* repo.patch(conv.id, { title: DEFAULT_TITLE });
      yield* answer(conv.id, 'And the eighth?', 2);
      assert.strictEqual((yield* repo.get(conv.id)).title, DEFAULT_TITLE);
      // A conversation renamed before its first message keeps its name.
      const named = yield* repo.create({ profileId: null, modelPath: null });
      yield* repo.patch(named.id, { title: 'Mine' });
      yield* answer(named.id, 'Hello', 3);
      assert.strictEqual((yield* repo.get(named.id)).title, 'Mine');
      yield* noRunLeft(runs, conv.id);
      yield* noRunLeft(runs, named.id);
    }),
  );

  it.effect('regenerate replaces what follows the last user message', () =>
    Effect.gen(function* () {
      const { llama, repo, conv, runs } = yield* setup();
      const first = yield* runs.send(conv.id, 'Hi');
      const firstEnd = yield* toEnd(first);
      yield* llama.requested(1);
      yield* llama.chunk({ content: 'Old' });
      yield* llama.done;
      yield* Fiber.join(firstEnd);
      const old = yield* assistantOf(repo, conv.id);
      assert.deepStrictEqual([old.status, old.content], ['done', 'Old']);

      const regenerated = yield* runs.regenerate(conv.id);
      const events = yield* toEnd(regenerated);
      yield* llama.requested(2);
      assert.deepStrictEqual(
        Option.map(Arr.get(llama.bodies(), 1), (body) => (body as { messages: unknown }).messages),
        Option.some([{ role: 'user', content: 'Hi' }]),
      );
      yield* llama.chunk({ content: 'New' });
      yield* llama.done;
      const [start] = yield* Fiber.join(events);
      assert.isTrue(start?.type === 'start' && start.user === null && start.assistant.status === 'streaming');
      const messages = yield* repo.messages(conv.id);
      assert.deepStrictEqual(
        Arr.map(messages, (m) => [m.role, m.status, m.content]),
        [
          ['user', 'done', 'Hi'],
          ['assistant', 'done', 'New'],
        ],
      );
      yield* noRunLeft(runs, conv.id);
    }),
  );

  it.effect('regenerate without a user message is NothingToRegenerate', () =>
    Effect.gen(function* () {
      const { llama, conv, runs } = yield* setup();
      const error = yield* Effect.flip(runs.regenerate(conv.id));
      assert.deepStrictEqual([error._tag, error.message], ['NothingToRegenerate', 'Nothing to regenerate']);
      assert.strictEqual(llama.requests(), 0);
      yield* noRunLeft(runs, conv.id);
    }),
  );

  it.effect('send with no ready server is ServerNotReady', () =>
    Effect.gen(function* () {
      const repo = yield* ConversationsRepo;
      // The supervisor is idle.
      const runs = yield* runsWith({});
      const conv = yield* repo.create({ profileId: null, modelPath: null });
      const error = yield* Effect.flip(runs.send(conv.id, 'Hi'));
      assert.deepStrictEqual([error._tag, error.message], ['ServerNotReady', 'llama-server is not ready']);
      const again = yield* Effect.flip(runs.regenerate(conv.id));
      assert.strictEqual(again._tag, 'ServerNotReady');
      const messages = yield* repo.messages(conv.id);
      assert.deepStrictEqual(messages, []);
      yield* noRunLeft(runs, conv.id);
    }),
  );

  it.effect('a blank message is EmptyMessage', () =>
    Effect.gen(function* () {
      const { llama, repo, conv, runs } = yield* setup();
      const error = yield* Effect.flip(runs.send(conv.id, ' \n\t '));
      assert.deepStrictEqual([error._tag, error.message], ['EmptyMessage', 'Empty message']);
      const messages = yield* repo.messages(conv.id);
      assert.deepStrictEqual(messages, []);
      assert.strictEqual(llama.requests(), 0);
      yield* noRunLeft(runs, conv.id);
    }),
  );

  it.effect('a missing conversation is ConversationNotFound, a stop without a reply NoReplyInProgress', () =>
    Effect.gen(function* () {
      const { conv, runs } = yield* setup();
      const sent = yield* Effect.flip(runs.send(9999, 'Hi'));
      assert.deepStrictEqual([sent._tag, sent.message], ['ConversationNotFound', 'Conversation not found']);
      const regenerated = yield* Effect.flip(runs.regenerate(9999));
      assert.strictEqual(regenerated._tag, 'ConversationNotFound');
      const stopped = yield* Effect.flip(runs.stop(conv.id));
      assert.deepStrictEqual([stopped._tag, stopped.message], ['NoReplyInProgress', 'No reply in progress']);
      assert.strictEqual((yield* Effect.flip(runs.stop(9999)))._tag, 'NoReplyInProgress');
      yield* runs.stopAndWait(conv.id);
      yield* noRunLeft(runs, conv.id);
    }),
  );

  it.effect('the done message is built in memory when the conversation was deleted', () =>
    Effect.gen(function* () {
      const { llama, repo, conv, runs } = yield* setup();
      const reply = yield* runs.send(conv.id, 'Hi');
      const end = yield* toEnd(reply);
      const listener = yield* follow(reply);
      yield* llama.requested(1);
      yield* llama.chunk({ content: 'Hel' });
      yield* listener.got(2);
      yield* repo.remove(conv.id);
      yield* llama.chunk({ content: 'lo' }, { timings: TIMINGS });
      yield* llama.done;
      const events = yield* Fiber.join(end);
      const [start] = events;
      const assistant = start?.type === 'start' ? start.assistant : assert.fail('no start');
      const done = doneOf(events);
      // With the stats a save would have written.
      assert.strictEqual(done.stats?.tgTps, 51.23);
      assert.deepStrictEqual(done, {
        ...assistant,
        content: 'Hello',
        reasoning: '',
        status: 'done',
        error: null,
        stats: done.stats,
      });
      const messages = yield* repo.messages(conv.id);
      assert.deepStrictEqual(messages, []);
      yield* noRunLeft(runs, conv.id);
    }),
  );

  it.effect('orphans are marked stopped when the layer is built', () =>
    Effect.gen(function* () {
      const repo = yield* ConversationsRepo;
      const conv = yield* repo.create({ profileId: null, modelPath: null });
      const orphan = yield* repo.addMessage(conv.id, { role: 'assistant', content: 'half', status: 'streaming' });
      const runs = yield* runsWith({ target: Effect.succeedNone });
      const [after] = yield* repo.messages(conv.id);
      assert.deepStrictEqual([after?.id, after?.status, after?.content], [orphan.id, 'stopped', 'half']);
      yield* noRunLeft(runs, conv.id);
    }),
  );

  it.effect('a reply whose timings give a non-finite rate is saved without stats', () =>
    Effect.gen(function* () {
      const { llama, repo, conv, runs } = yield* setup();
      const reply = yield* runs.send(conv.id, 'Hi');
      const end = yield* toEnd(reply);
      yield* llama.requested(1);
      yield* llama.chunk({ content: 'Yes' });
      // 1e999 is Infinity once parsed.
      yield* llama.write(
        'data: {"choices":[{"index":0,"delta":{}}],"timings":{"prompt_n":10,"prompt_per_second":200,"predicted_n":3,"predicted_per_second":1e999}}\n\n',
      );
      yield* llama.done;
      const done = yield* doneAt(end);
      assert.deepStrictEqual([done.status, done.content, done.stats], ['done', 'Yes', null]);
      const a = yield* assistantOf(repo, conv.id);
      assert.deepStrictEqual([a.status, a.stats], ['done', null]);
      yield* noRunLeft(runs, conv.id);
    }),
  );
});

layer(Base)('ChatRuns on the TestClock', (it) => {
  it.effect('the text is written at most once per flushInterval', () =>
    Effect.gen(function* () {
      const { llama, repo, conv, runs } = yield* setup({ flushInterval: '1 second' });
      const reply = yield* runs.send(conv.id, 'Hi');
      const end = yield* toEnd(reply);
      const listener = yield* follow(reply);
      const stored = (expected: ReadonlyArray<string>) =>
        Effect.map(assistantOf(repo, conv.id), (a) => assert.deepStrictEqual([a.status, a.content], expected));
      yield* llama.requested(1);
      yield* TestClock.adjust('1 second');
      yield* llama.chunk({ content: 'a' });
      yield* listener.got(2);
      yield* stored(['streaming', 'a']);
      yield* TestClock.adjust('500 millis');
      yield* llama.chunk({ content: 'b' });
      yield* listener.got(3);
      yield* stored(['streaming', 'a']);
      yield* TestClock.adjust('1 second');
      yield* llama.chunk({ content: 'c' });
      yield* listener.got(4);
      yield* stored(['streaming', 'abc']);
      yield* llama.done;
      yield* Fiber.join(end);
      yield* stored(['done', 'abc']);
      yield* noRunLeft(runs, conv.id);
    }),
  );
});
