import { Api, activeProfileId, ChatSseEvent, type ConversationDetail } from '@llama-webui/shared';
import { Effect, Option, Path, Schema, Stream } from 'effect';
import { HttpApiBuilder } from 'effect/http-api';
import { homeDir } from '../config/Home.ts';
import { sseResponse } from '../http/Sse.ts';
import { ProfilesRepo } from '../profiles/ProfilesRepo.ts';
import { profilePaths } from '../supervisor/command.ts';
import { Supervisor } from '../supervisor/Supervisor.ts';
import { type ChatReply, ChatRuns } from './ChatRuns.ts';
import { ConversationsRepo } from './ConversationsRepo.ts';

const encodeEvent = Schema.encodeEffect(ChatSseEvent);

/**
 * A reply as the Nitro server streamed it: each `ChatEvent` one server-sent event (`event:` its type, `data:` its JSON),
 * with the headers and the `: ping` of `sseResponse`. A client that goes away only leaves the reply's events.
 */
const replyResponse = (reply: ChatReply) => sseResponse(Stream.mapEffect(reply.events, (event) => encodeEvent(event)));

/** The endpoints of `/api/chat`: the conversations on their repository, the replies on `ChatRuns`. */
export const ChatHandlers = HttpApiBuilder.group(
  Api,
  'chat',
  Effect.fn(function* (handlers) {
    const repo = yield* ConversationsRepo;
    const runs = yield* ChatRuns;
    const profiles = yield* ProfilesRepo;
    const supervisor = yield* Supervisor;
    const path = yield* Path.Path;

    /** The conversation with its messages, `live` while a reply is written. */
    const detail = Effect.fn('ChatHandlers.detail')(function* (id: number) {
      const conversation = yield* repo.get(id);
      const messages = yield* repo.messages(id);
      const live = yield* runs.isLive(id);
      const reply: ConversationDetail = { ...conversation, messages, live };
      return reply;
    });

    const list = repo.list.pipe(
      Effect.flatMap((summaries) =>
        Effect.forEach(summaries, (summary) => Effect.map(runs.isLive(summary.id), (live) => ({ ...summary, live }))),
      ),
      Effect.withSpan('ChatHandlers.list'),
    );

    /** A conversation on the profile `id` and its model, as llama-server opens it. */
    const onProfile = Effect.fn('ChatHandlers.onProfile')(function* (id: number) {
      const profile = yield* profiles.get(id);
      const home = yield* homeDir;
      const { model } = profilePaths({ profile, home, cwd: path.resolve('.'), path });
      return yield* repo.create({ profileId: profile.id, modelPath: model });
    });

    /**
     * A conversation on a profile: omitted, the profile of the server llama-webui runs (starting, ready or stopping),
     * else none; null, none. The model is the profile's, as llama-server opens it.
     */
    const create = Effect.fn('ChatHandlers.create')(function* (profileId: number | null | undefined) {
      const state = yield* supervisor.state;
      const id = profileId === undefined ? activeProfileId(state) : profileId;
      const conversation = yield* id === null ? repo.create({ profileId: null, modelPath: null }) : onProfile(id);
      const reply: ConversationDetail = { ...conversation, messages: [], live: false };
      return reply;
    });

    /** The reply in progress is stopped and saved first: its clients get its `done`, then the rows go. */
    const remove = Effect.fn('ChatHandlers.remove')(function* (id: number) {
      yield* runs.stopAndWait(id);
      yield* repo.remove(id);
    });

    /** The reply being written, or a 204 when none is. */
    const follow = Effect.fn('ChatHandlers.follow')(function* (id: number) {
      yield* repo.get(id);
      const reply = yield* runs.live(id);
      if (Option.isNone(reply)) return;
      return yield* replyResponse(reply.value);
    });

    return handlers
      .handle('list', () => list)
      .handle('create', ({ payload }) => create(payload.profileId))
      .handle('get', ({ params }) => detail(params.id))
      .handle('patch', ({ params, payload }) => Effect.flatMap(repo.patch(params.id, payload), () => detail(params.id)))
      .handle('remove', ({ params }) => remove(params.id))
      .handle('send', ({ params, payload }) => Effect.flatMap(runs.send(params.id, payload.content), replyResponse))
      .handle('regenerate', ({ params }) => Effect.flatMap(runs.regenerate(params.id), replyResponse))
      .handle('stop', ({ params }) => runs.stop(params.id))
      .handle('follow', ({ params }) => follow(params.id));
  }),
);
