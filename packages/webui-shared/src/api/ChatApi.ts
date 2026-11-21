import { Schema, SchemaTransformation } from 'effect';
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from 'effect/http-api';
import { ChatEvent, ConversationDetail, ConversationPatch, ConversationSummary } from '../chat.ts';
import { ProfileNotFound } from './ProfilesApi.ts';
import { IdParam } from './params.ts';
import { ServerNotReady } from './ServerApi.ts';

/** No conversation has this id: `Conversation not found`. */
export class ConversationNotFound extends Schema.TaggedError<
  ConversationNotFound,
  { readonly ConversationNotFound: unique symbol }
>()('ConversationNotFound', { message: Schema.String }, { httpApiStatus: 404 }) {}

/** A send or a regeneration while a reply is written: `A reply is already in progress in this conversation`. */
export class ReplyInProgress extends Schema.TaggedError<ReplyInProgress, { readonly ReplyInProgress: unique symbol }>()(
  'ReplyInProgress',
  { message: Schema.String },
  { httpApiStatus: 409 },
) {}

/** A stop while no reply is written (or of a conversation that does not exist): `No reply in progress`. */
export class NoReplyInProgress extends Schema.TaggedError<
  NoReplyInProgress,
  { readonly NoReplyInProgress: unique symbol }
>()('NoReplyInProgress', { message: Schema.String }, { httpApiStatus: 409 }) {}

/** A regeneration of a conversation with no user message: `Nothing to regenerate`. */
export class NothingToRegenerate extends Schema.TaggedError<
  NothingToRegenerate,
  { readonly NothingToRegenerate: unique symbol }
>()('NothingToRegenerate', { message: Schema.String }, { httpApiStatus: 409 }) {}

/** A message with nothing but blanks: `Empty message`. */
export class EmptyMessage extends Schema.TaggedError<EmptyMessage, { readonly EmptyMessage: unique symbol }>()(
  'EmptyMessage',
  { message: Schema.String },
  { httpApiStatus: 400 },
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
export class ChatApi extends HttpApiGroup.make('chat').add(
  HttpApiEndpoint.get('list', '/api/chat', { success: Schema.Array(ConversationSummary) }),
  // `profileId` omitted: the running server's profile; null: none.
  HttpApiEndpoint.post('create', '/api/chat', {
    payload: Schema.Struct({ profileId: Schema.optionalKey(Schema.NullOr(Schema.Int)) }),
    success: ConversationDetail.pipe(HttpApiSchema.status(201)),
    error: ProfileNotFound,
  }),
  HttpApiEndpoint.get('get', '/api/chat/:id', { params, success: ConversationDetail, error: ConversationNotFound }),
  HttpApiEndpoint.patch('patch', '/api/chat/:id', {
    params,
    payload: ConversationPatch,
    success: ConversationDetail,
    error: ConversationNotFound,
  }),
  HttpApiEndpoint.delete('remove', '/api/chat/:id', { params, error: ConversationNotFound }),
  HttpApiEndpoint.post('send', '/api/chat/:id/messages', {
    params,
    payload: Schema.Struct({ content: Schema.String }),
    success: Reply,
    error: [EmptyMessage, ConversationNotFound, ReplyInProgress, ServerNotReady],
  }),
  HttpApiEndpoint.post('regenerate', '/api/chat/:id/regenerate', {
    params,
    success: Reply,
    error: [ConversationNotFound, ReplyInProgress, ServerNotReady, NothingToRegenerate],
  }),
  HttpApiEndpoint.post('stop', '/api/chat/:id/stop', { params, error: NoReplyInProgress }),
  // The reply being written, or a 204 when none is.
  HttpApiEndpoint.get('follow', '/api/chat/:id/stream', {
    params,
    success: [Reply, HttpApiSchema.NoContent],
    error: ConversationNotFound,
  }),
) {}
