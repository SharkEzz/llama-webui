import { Schema, SchemaTransformation } from 'effect';
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from 'effect/http-api';
import { ChatEvent, ConversationDetail, ConversationPatch, ConversationSummary } from '../chat.ts';
import { IdParam } from './params.ts';
import { ProfileNotFound } from './ProfilesApi.ts';
import { ServerNotReady } from './ServerApi.ts';

/** No conversation has this id: `Conversation not found`. */
export class ConversationNotFound extends Schema.TaggedError<
  ConversationNotFound,
  { readonly ConversationNotFound: unique symbol }
>()(
  'ConversationNotFound',
  { message: Schema.String },
  { httpApiStatus: 404, description: 'ConversationNotFound: No conversation exists with the given id.' },
) {}

/** A send or a regeneration while a reply is written: `A reply is already in progress in this conversation`. */
export class ReplyInProgress extends Schema.TaggedError<ReplyInProgress, { readonly ReplyInProgress: unique symbol }>()(
  'ReplyInProgress',
  { message: Schema.String },
  { httpApiStatus: 409, description: 'ReplyInProgress: A reply is already streaming for this conversation.' },
) {}

/** A stop while no reply is written (or of a conversation that does not exist): `No reply in progress`. */
export class NoReplyInProgress extends Schema.TaggedError<
  NoReplyInProgress,
  { readonly NoReplyInProgress: unique symbol }
>()(
  'NoReplyInProgress',
  { message: Schema.String },
  {
    httpApiStatus: 409,
    description: 'NoReplyInProgress: No active reply is currently streaming for this conversation.',
  },
) {}

/** A regeneration of a conversation with no user message: `Nothing to regenerate`. */
export class NothingToRegenerate extends Schema.TaggedError<
  NothingToRegenerate,
  { readonly NothingToRegenerate: unique symbol }
>()(
  'NothingToRegenerate',
  { message: Schema.String },
  { httpApiStatus: 409, description: 'NothingToRegenerate: The conversation has no user message to regenerate from.' },
) {}

/** A message with nothing but blanks: `Empty message`. */
export class EmptyMessage extends Schema.TaggedError<EmptyMessage, { readonly EmptyMessage: unique symbol }>()(
  'EmptyMessage',
  { message: Schema.String },
  { httpApiStatus: 400, description: 'EmptyMessage: The message content contains only whitespace.' },
) {}

/**
 * A `ChatEvent` as one server-sent event, as the Nitro server sent it: `event:` its type, `data:` the JSON of the
 * whole event.
 */
export const ChatSseEvent = Schema.Struct({ event: Schema.String, data: Schema.fromJsonString(ChatEvent) }).pipe(
  Schema.decodeTo(
    Schema.toType(ChatEvent),
    SchemaTransformation.transform({
      decode: ({ data }) => data,
      encode: (data) => ({ event: data.type, data }),
    }),
  ),
);

/** A reply as it is written: one `ChatSseEvent` per `ChatEvent`, until `done`. */
const Reply = HttpApiSchema.StreamSse({ events: ChatSseEvent });
const params = { id: IdParam };

/** The conversations, their messages and the replies of llama-server, streamed as server-sent events. */
export class ChatApi extends HttpApiGroup.make('chat')
  .add(
    HttpApiEndpoint.get('list', '/api/chat', { success: Schema.Array(ConversationSummary) }).annotateMerge(
      OpenApi.annotations({
        summary: 'List conversations',
        description:
          'Returns all conversations sorted by `updatedAt` descending, with message counts and `live` status.',
      }),
    ),
    // `profileId` omitted: the running server's profile; null: none.
    HttpApiEndpoint.post('create', '/api/chat', {
      payload: Schema.Struct({ profileId: Schema.Int.pipe(Schema.NullOr, Schema.optionalKey) }),
      success: ConversationDetail.pipe(HttpApiSchema.status(201)),
      error: ProfileNotFound,
    }).annotateMerge(
      OpenApi.annotations({
        summary: 'Create a conversation',
        description:
          'Creates a new conversation (`201 Created`). Omit `profileId` to bind the currently running profile, or pass `null` for none.',
      }),
    ),
    HttpApiEndpoint.get('get', '/api/chat/:id', {
      params,
      success: ConversationDetail,
      error: ConversationNotFound,
    }).annotateMerge(
      OpenApi.annotations({
        summary: 'Get a conversation',
        description: 'Returns one conversation with its ordered message history and `live` indicator.',
      }),
    ),
    HttpApiEndpoint.patch('patch', '/api/chat/:id', {
      params,
      payload: ConversationPatch,
      success: ConversationDetail,
      error: ConversationNotFound,
    }).annotateMerge(
      OpenApi.annotations({
        summary: 'Update conversation settings',
        description:
          'Updates title, system prompt, thinking toggle, or sampling overrides (providing `sampling` replaces the whole object).',
      }),
    ),
    HttpApiEndpoint.delete('remove', '/api/chat/:id', { params, error: ConversationNotFound }).annotateMerge(
      OpenApi.annotations({
        summary: 'Delete a conversation',
        description: 'Stops any active reply and deletes the conversation and all its messages (`204 No Content`).',
      }),
    ),
    HttpApiEndpoint.post('send', '/api/chat/:id/messages', {
      params,
      payload: Schema.Struct({ content: Schema.String }),
      success: Reply,
      error: [EmptyMessage, ConversationNotFound, ReplyInProgress, ServerNotReady],
    }).annotateMerge(
      OpenApi.annotations({
        summary: 'Send a message and stream the reply',
        description:
          'Appends the user message, starts a server-owned completion against `llama-server`, and streams `text/event-stream` (`start`, `delta`, `done`, plus `: ping` every 15 s). Disconnecting unsubscribes without stopping generation.',
      }),
    ),
    HttpApiEndpoint.post('regenerate', '/api/chat/:id/regenerate', {
      params,
      success: Reply,
      error: [ConversationNotFound, ReplyInProgress, ServerNotReady, NothingToRegenerate],
    }).annotateMerge(
      OpenApi.annotations({
        summary: 'Regenerate the last reply',
        description:
          'Deletes the last assistant reply (if any), regenerates from the last user message, and streams the SSE events (`user: null` in `start`).',
      }),
    ),
    HttpApiEndpoint.post('stop', '/api/chat/:id/stop', { params, error: NoReplyInProgress }).annotateMerge(
      OpenApi.annotations({
        summary: 'Stop an in-progress reply',
        description:
          'Aborts the active generation, persists the partial reply with status `stopped`, emits a final `done` SSE event, and returns `204 No Content`.',
      }),
    ),
    // The reply being written, or a 204 when none is.
    HttpApiEndpoint.get('follow', '/api/chat/:id/stream', {
      params,
      success: [Reply, HttpApiSchema.NoContent],
      error: ConversationNotFound,
    }).annotateMerge(
      OpenApi.annotations({
        summary: 'Attach to an in-progress reply stream',
        description:
          'Replays accumulated chunks and streams live SSE events if a reply is currently running, or returns `204 No Content` when idle.',
      }),
    ),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: 'Chat',
      description:
        'Conversations, persisted messages, and server-owned `llama-server` generations streamed over Server-Sent Events (`text/event-stream`). Generations continue even if the client disconnects and can be re-attached via `GET /api/chat/:id/stream`.',
    }),
  ) {}
