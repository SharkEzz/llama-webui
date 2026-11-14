import {
  autoTitle,
  type ChatEvent,
  type ChatMessage,
  type Conversation,
  type ConversationNotFound,
  EmptyMessage,
  isDefaultTitle,
  type LlamaTimingsSchema,
  MessageStats,
  type MessageStatus,
  NoReplyInProgress,
  NothingToRegenerate,
  ReplyInProgress,
  ServerNotReady,
  statsFromTimings,
} from '@llama-webui/shared';
import {
  Array as Arr,
  Cause,
  Clock,
  Context,
  Deferred,
  Duration,
  Effect,
  Exit,
  Layer,
  Option,
  type Path,
  PubSub,
  Ref,
  Schema,
  String as Str,
  Stream,
  SynchronizedRef,
} from 'effect';
import { probeUrl } from 'llamacpp-js/client';
import { type ChatChunk, streamChat } from '../llama/chatStream.ts';
import { LlamaHttp } from '../llama/LlamaHttp.ts';
import type { ProfilesRepo } from '../profiles/ProfilesRepo.ts';
import { Shutdown } from '../runtime/Shutdown.ts';
import type { Supervisor } from '../supervisor/Supervisor.ts';
import { ConversationsRepo } from './ConversationsRepo.ts';
import { buildChatRequest, failureMessage } from './request.ts';
import { type ChatTarget, chatTarget } from './target.ts';

/** A reply being written, as its clients follow it. */
export interface ChatReply {
  /**
   * Its events, subscribed when the stream starts: `start`, one `delta` of what was written so far when there is any,
   * then `done` at once when the reply ended, else the live deltas until `done`.
   */
  readonly events: Stream.Stream<ChatEvent>;
}

/** What a run has written, and its reply as saved once it ended. */
interface Written {
  readonly content: string;
  readonly reasoning: string;
  /** When the text was last written to the table (the start before the first write). */
  readonly writtenAt: number;
  /** The reply as saved: set once, by the end of the run or by the shutdown step; nothing is written after it. */
  readonly final: Option.Option<ChatMessage>;
}

/** A reply in progress. */
interface Run {
  readonly conversationId: number;
  readonly user: ChatMessage | null;
  readonly assistant: ChatMessage;
  /** What it wrote; its deltas and its `done` are published inside the change, so a subscriber misses none. */
  readonly written: SynchronizedRef.SynchronizedRef<Written>;
  readonly events: PubSub.PubSub<ChatEvent>;
  /** Completed by `stop`: the consumption of the stream ends, its request aborted. */
  readonly stopped: Deferred.Deferred<void>;
  /** Completed once the run ended and left the runs. */
  readonly ended: Deferred.Deferred<void>;
}

/** How the consumption of a reply ended. */
interface Outcome {
  readonly status: MessageStatus;
  readonly error: string | null;
}

/** What the start of a run needs: the conversation, its target and the user message (none on a regeneration). */
interface Start {
  readonly conversation: Conversation;
  readonly target: ChatTarget;
  readonly user: ChatMessage | null;
}

const replyInProgress = () => ReplyInProgress.make({ message: 'A reply is already in progress in this conversation' });
const serverNotReady = () => ServerNotReady.make({ message: 'llama-server is not ready' });

/** A delta event with the keys that have text. */
const deltaOf = (content: string, reasoning: string): ChatEvent => ({
  type: 'delta',
  ...(Str.isNonEmpty(content) ? { content } : {}),
  ...(Str.isNonEmpty(reasoning) ? { reasoning } : {}),
});

/** What a subscriber gets at once: the start, what was written so far, and the `done` of a reply that ended. */
const replayOf = (run: Run, written: Written): ReadonlyArray<ChatEvent> => [
  { type: 'start', user: run.user, assistant: run.assistant },
  ...(Str.isNonEmpty(written.content) || Str.isNonEmpty(written.reasoning)
    ? [deltaOf(written.content, written.reasoning)]
    : []),
  ...Option.match(written.final, {
    onNone: () => [],
    onSome: (message): ReadonlyArray<ChatEvent> => [{ type: 'done', message }],
  }),
];

const isDone = (event: ChatEvent) => event.type === 'done';

/** The events of `run` from the subscription on: the replay and the subscription are taken in one step. */
const replyOf = (run: Run): ChatReply => ({
  events: Stream.unwrap(
    SynchronizedRef.modifyEffect(run.written, (written) =>
      Option.match(written.final, {
        onSome: () => Effect.succeed(Stream.fromIterable(replayOf(run, written))),
        onNone: () =>
          Effect.map(PubSub.subscribe(run.events), (subscription) =>
            Stream.concat(
              Stream.fromIterable(replayOf(run, written)),
              Stream.fromSubscription(subscription).pipe(Stream.takeUntil(isDone)),
            ),
          ),
      }).pipe(Effect.map((events) => [events, written] as const)),
    ),
  ),
});

/** The first choice's delta of a chunk: a null text is no text. */
const textOf = (chunk: ChatChunk) => {
  const delta = Option.flatMap(Arr.head(chunk.choices ?? []), (choice) => Option.fromNullishOr(choice.delta));
  return {
    content: Option.flatMap(delta, (d) => Option.fromNullishOr(d.content)).pipe(Option.getOrElse(() => '')),
    reasoning: Option.flatMap(delta, (d) => Option.fromNullishOr(d.reasoning_content)).pipe(Option.getOrElse(() => '')),
  };
};

/**
 * A stats every number of which is finite (`MessageStats` encodes no other, and `updateMessage` dies on any other). A
 * backstop: the timings decoder already drops non-finite values, and the ttft and the duration come from the `Clock`.
 */
const isEncodable = Schema.is(MessageStats);

/** The replies being written: at most one per conversation, each in a fiber of its own, saved as it streams. */
export class ChatRuns extends Context.Service<
  ChatRuns,
  {
    /** Stores `content` (trimmed) as the next user message and starts the reply. */
    readonly send: (
      id: number,
      content: string,
    ) => Effect.Effect<ChatReply, EmptyMessage | ConversationNotFound | ReplyInProgress | ServerNotReady>;
    /** Replaces what follows the last user message with a new reply. */
    readonly regenerate: (
      id: number,
    ) => Effect.Effect<ChatReply, ConversationNotFound | ReplyInProgress | ServerNotReady | NothingToRegenerate>;
    /** Ends the reply of `id` (saved `stopped`), without waiting for it. */
    readonly stop: (id: number) => Effect.Effect<void, NoReplyInProgress>;
    /** The reply being written in `id`, if any. */
    readonly live: (id: number) => Effect.Effect<Option.Option<ChatReply>>;
    readonly isLive: (id: number) => Effect.Effect<boolean>;
    /** Stops the reply of `id`, if any, and waits for its end (before the conversation is deleted). */
    readonly stopAndWait: (id: number) => Effect.Effect<void>;
  }
>()('@llama-webui/app/server/chat/ChatRuns') {
  /**
   * The replies: the text so far is written at most every `flushInterval`, each reply is asked of `target` (the
   * llama-server `chatTarget` finds by default). The replies a hard stop left `streaming` are marked `stopped` when the
   * layer is built; when the app stops, a shutdown step saves every reply in progress `stopped` and ends its clients'
   * streams, and the end of the layer interrupts what is left.
   */
  static readonly layerWith = (options: {
    readonly flushInterval: Duration.Input;
    readonly target?: Effect.Effect<Option.Option<ChatTarget>>;
  }): Layer.Layer<ChatRuns, never, ConversationsRepo | LlamaHttp | Shutdown | Supervisor | ProfilesRepo | Path.Path> =>
    Layer.effect(
      ChatRuns,
      Effect.gen(function* () {
        const repo = yield* ConversationsRepo;
        const http = yield* LlamaHttp;
        const shutdown = yield* Shutdown;
        const context = yield* Effect.context<Supervisor | ProfilesRepo | Path.Path>();
        const target = options.target ?? chatTarget.pipe(Effect.provideContext(context));
        const flushMs = Duration.toMillis(Duration.fromInputUnsafe(options.flushInterval));
        const scope = yield* Effect.scope;

        yield* repo.stopOrphans;

        /** The runs by conversation: checked and registered in one step, so two sends at once give one run. */
        const runs = yield* SynchronizedRef.make<ReadonlyMap<number, Run>>(new Map());

        const withoutRun = (run: Run) =>
          SynchronizedRef.update(runs, (now) => {
            if (now.get(run.conversationId) !== run) return now;
            const next = new Map(now);
            next.delete(run.conversationId);
            return next;
          });

        /**
         * Saves the reply as it ends (`stats` undefined keeps the stored ones) and publishes its `done`, unless it was
         * saved already; `leave` takes the run out of the runs first.
         */
        const save = (options: {
          readonly run: Run;
          readonly outcome: Outcome;
          readonly stats: Effect.Effect<MessageStats | null | undefined>;
          readonly leave: boolean;
        }) => {
          const { run, outcome, stats } = options;
          return SynchronizedRef.updateEffect(run.written, (written) =>
            Option.isSome(written.final)
              ? Effect.succeed(written)
              : Effect.gen(function* () {
                  const fields = {
                    content: written.content,
                    reasoning: written.reasoning,
                    status: outcome.status,
                    error: outcome.error,
                  };
                  const measured = yield* stats;
                  const saved = yield* repo
                    .updateMessage(run.assistant.id, measured === undefined ? fields : { ...fields, stats: measured })
                    .pipe(
                      // The conversation was deleted while the reply was written: the message it would have saved.
                      Effect.catchTag('MessageNotFound', () =>
                        Effect.succeed({
                          ...run.assistant,
                          ...fields,
                          ...(measured === undefined ? {} : { stats: measured }),
                        }),
                      ),
                    );
                  // Out of the runs before its `done`: a client that sends on `done` finds no reply in progress.
                  if (options.leave) yield* withoutRun(run);
                  yield* PubSub.publish(run.events, { type: 'done', message: saved });
                  return { ...written, final: Option.some(saved) };
                }),
          );
        };

        /** Appends a delta, writes the text when `flushMs` passed since the last write, and publishes the delta. */
        const append = (run: Run, content: string, reasoning: string, now: number) =>
          SynchronizedRef.updateEffect(run.written, (written) =>
            Option.isSome(written.final)
              ? Effect.succeed(written)
              : Effect.gen(function* () {
                  const next = {
                    ...written,
                    content: written.content + content,
                    reasoning: written.reasoning + reasoning,
                  };
                  const due = now - written.writtenAt >= flushMs;
                  if (due) {
                    yield* repo
                      .updateMessage(run.assistant.id, { content: next.content, reasoning: next.reasoning })
                      .pipe(Effect.catchTag('MessageNotFound', () => Effect.void));
                  }
                  yield* PubSub.publish(run.events, deltaOf(content, reasoning));
                  return due ? { ...next, writtenAt: now } : next;
                }),
          );

        /** Consumes the reply of `run` until it ends or is stopped, then saves it. */
        const consume = (run: Run, baseUrl: string, body: unknown, started: number) =>
          Effect.gen(function* () {
            const ttft = yield* Ref.make(Option.none<number>());
            const timings = yield* Ref.make(Option.none<LlamaTimingsSchema>());
            const outcome = yield* streamChat(baseUrl, body).pipe(
              Stream.runForEach((chunk) =>
                Effect.gen(function* () {
                  if (chunk.timings !== undefined) yield* Ref.set(timings, Option.some(chunk.timings));
                  const { content, reasoning } = textOf(chunk);
                  if (Str.isEmpty(content) && Str.isEmpty(reasoning)) return;
                  const now = yield* Clock.currentTimeMillis;
                  yield* Ref.update(
                    ttft,
                    Option.orElse(() => Option.some(now - started)),
                  );
                  yield* append(run, content, reasoning, now);
                }),
              ),
              Effect.as<Outcome>({ status: 'done', error: null }),
              Effect.catch((failure) => Effect.succeed<Outcome>({ status: 'error', error: failureMessage(failure) })),
              Effect.provideService(LlamaHttp, http),
              Effect.raceFirst(
                Deferred.await(run.stopped).pipe(Effect.as<Outcome>({ status: 'stopped', error: null })),
              ),
            );
            const statsOf = Effect.gen(function* () {
              const last = yield* Ref.get(timings);
              if (Option.isNone(last)) return null;
              const now = yield* Clock.currentTimeMillis;
              const first = yield* Ref.get(ttft);
              const stats = statsFromTimings(last.value, Option.getOrNull(first), now - started);
              return isEncodable(stats) ? stats : null;
            });
            yield* save({ run, outcome, stats: statsOf, leave: true });
          }).pipe(
            Effect.onExit((exit) =>
              Effect.gen(function* () {
                yield* withoutRun(run);
                if (Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)) {
                  yield* Effect.logError(`the reply of conversation ${run.conversationId} failed`, exit.cause);
                }
                // Interrupted (the end of the layer) or dead before it was saved: its clients' streams end.
                const { final } = yield* SynchronizedRef.get(run.written);
                if (Exit.isFailure(exit) && Option.isNone(final)) yield* PubSub.shutdown(run.events);
                yield* Deferred.succeed(run.ended, undefined);
              }),
            ),
          );

        /**
         * The rest of a start, under the runs' lock: the conversation takes the target's model when it has none, the
         * reply is stored `streaming` with the target's model, and its run is forked and registered.
         */
        const begin = (now: ReadonlyMap<number, Run>, start: Start) =>
          Effect.gen(function* () {
            const { conversation, target: to, user } = start;
            const { id } = conversation;
            // The conversation keeps the model it started with; each reply records its own.
            if (conversation.modelPath === null && to.modelPath !== null) {
              yield* repo.setModel(id, to.profileId, to.modelPath);
            }
            const history = yield* repo.messages(id);
            const assistant = yield* repo.addMessage(id, {
              role: 'assistant',
              content: '',
              status: 'streaming',
              model: to.modelPath,
            });
            const started = yield* Clock.currentTimeMillis;
            const run: Run = {
              conversationId: id,
              user,
              assistant,
              written: yield* SynchronizedRef.make<Written>({
                content: '',
                reasoning: '',
                writtenAt: started,
                final: Option.none(),
              }),
              events: yield* PubSub.unbounded<ChatEvent>(),
              stopped: yield* Deferred.make<void>(),
              ended: yield* Deferred.make<void>(),
            };
            const body = buildChatRequest(conversation, history);
            yield* Effect.forkIn(consume(run, probeUrl(to.host, to.port), body, started), scope);
            return [replyOf(run), new Map(now).set(id, run)] as const;
          });

        /**
         * `prepare` and the start in one step under the runs' lock, uninterrupted: the conversation exists, no run is
         * in it, a server answers, then `prepare` stores what precedes the reply and the run is registered.
         */
        const starting = <E>(
          id: number,
          prepare: (conversation: Conversation) => Effect.Effect<ChatMessage | null, E>,
        ): Effect.Effect<ChatReply, E | ConversationNotFound | ReplyInProgress | ServerNotReady> =>
          SynchronizedRef.modifyEffect(runs, (now) =>
            Effect.gen(function* () {
              const conversation = yield* repo.get(id);
              if (now.has(id)) return yield* replyInProgress();
              const to = yield* target;
              if (Option.isNone(to)) return yield* serverNotReady();
              const user = yield* prepare(conversation);
              return yield* begin(now, { conversation, target: to.value, user });
            }),
          ).pipe(Effect.uninterruptible);

        const send = Effect.fn('ChatRuns.send')(function* (id: number, content: string) {
          const text = Str.trim(content);
          if (Str.isEmpty(text)) return yield* EmptyMessage.make({ message: 'Empty message' });
          return yield* starting(id, (conversation) =>
            Effect.gen(function* () {
              const user = yield* repo.addMessage(id, { role: 'user', content: text, status: 'done' });
              const messages = yield* repo.messages(id);
              const users = Arr.filter(messages, (m) => m.role === 'user').length;
              if (isDefaultTitle(conversation.title) && users === 1) yield* repo.setTitle(id, autoTitle(text));
              return user;
            }),
          );
        });

        const regenerate = Effect.fn('ChatRuns.regenerate')(function* (id: number) {
          return yield* starting(id, () =>
            Effect.gen(function* () {
              const messages = yield* repo.messages(id);
              const lastUser = Arr.findLastIndex(messages, (m) => m.role === 'user');
              if (Option.isNone(lastUser)) {
                return yield* NothingToRegenerate.make({ message: 'Nothing to regenerate' });
              }
              const after = Arr.get(messages, lastUser.value + 1);
              if (Option.isSome(after)) yield* repo.deleteFrom(id, after.value.id);
              return null;
            }),
          );
        });

        const runOf = (id: number) => Effect.map(SynchronizedRef.get(runs), (now) => Option.fromNullishOr(now.get(id)));

        /** The runs, read under their lock: after a start in flight, which a plain read would miss. */
        const lockedRuns = SynchronizedRef.modify(runs, (now) => [now, now] as const);

        const stop = Effect.fn('ChatRuns.stop')(function* (id: number) {
          const run = yield* runOf(id);
          if (Option.isNone(run)) return yield* NoReplyInProgress.make({ message: 'No reply in progress' });
          yield* Deferred.succeed(run.value.stopped, undefined);
        });

        const stopAndWait = Effect.fn('ChatRuns.stopAndWait')(function* (id: number) {
          // Read under the lock, waited for outside it: the run's end takes the lock to leave the runs.
          const now = yield* lockedRuns;
          const run = now.get(id);
          if (run === undefined) return;
          yield* Deferred.succeed(run.stopped, undefined);
          yield* Deferred.await(run.ended);
        });

        const live = Effect.fn('ChatRuns.live')(function* (id: number) {
          const run = yield* runOf(id);
          return Option.map(run, replyOf);
        });

        const isLive = Effect.fn('ChatRuns.isLive')(function* (id: number) {
          const run = yield* runOf(id);
          return Option.isSome(run);
        });

        // While the clients are still connected: every reply is stopped and saved `stopped` with its text so far, its
        // `done` ends the clients' streams, and its run writes nothing after it.
        yield* shutdown.before(
          Effect.gen(function* () {
            const now = yield* lockedRuns;
            yield* Effect.forEach(
              now.values(),
              (run) =>
                // Saved before the stop: the run, once stopped, finds its reply saved and writes nothing. It leaves the
                // runs at its end, which follows at once.
                save({ run, outcome: { status: 'stopped', error: null }, stats: Effect.undefined, leave: false }).pipe(
                  Effect.andThen(Deferred.succeed(run.stopped, undefined)),
                ),
              { discard: true },
            );
          }).pipe(Effect.withSpan('ChatRuns.shutdown')),
        );

        return ChatRuns.of({ send, regenerate, stop, live, isLive, stopAndWait });
      }),
    );

  /** The text written at most every second; the replies asked of the server `chatTarget` finds. */
  static readonly layer = ChatRuns.layerWith({ flushInterval: '1 second' });
}
