import { Effect, Filter, Option, Predicate, Schema, Stream } from 'effect';
import { Sse } from 'effect/encoding';
import { dual, identity } from 'effect/Function';
import { type HttpClientError, HttpClientRequest } from 'effect/http';
import { type ChatCompletionChunk, readChatEvent } from 'llamacpp-js/client';
import { parseLlamaError } from 'llamacpp-js/errors';
import { LlamaHttp } from './LlamaHttp.ts';

/**
 * The `error` object llama-server sends, in an HTTP error body or in a stream event, as the failures below carry it:
 * `LlamaError` of `llamacpp-js/errors`, which reads it field by field (`readLlamaError`).
 */
export const LlamaError = Schema.Struct({
  code: Schema.optionalKey(Schema.Finite),
  message: Schema.optionalKey(Schema.String),
  type: Schema.optionalKey(Schema.String),
  n_prompt_tokens: Schema.optionalKey(Schema.Finite),
  n_ctx: Schema.optionalKey(Schema.Finite),
});
export type LlamaError = typeof LlamaError.Type;

/** llama-server answered with an error status; `error` is the JSON error of its body, when the body has one. */
export class LlamaHttpFailed extends Schema.TaggedError<LlamaHttpFailed, { readonly LlamaHttpFailed: unique symbol }>()(
  'LlamaHttpFailed',
  { status: Schema.Int, body: Schema.String, error: Schema.Option(LlamaError) },
) {}

/** The stream sent an error event. */
export class LlamaStreamFailed extends Schema.TaggedError<
  LlamaStreamFailed,
  { readonly LlamaStreamFailed: unique symbol }
>()('LlamaStreamFailed', { error: LlamaError }) {}

/** The stream ended, or its connection broke, before its `[DONE]`. */
export class LlamaStreamCut extends Schema.TaggedError<LlamaStreamCut, { readonly LlamaStreamCut: unique symbol }>()(
  'LlamaStreamCut',
  {},
) {}

/** The request never got its answer: nothing listens there, or the connection failed before the headers. */
export class LlamaUnreachable extends Schema.TaggedError<
  LlamaUnreachable,
  { readonly LlamaUnreachable: unique symbol }
>()('LlamaUnreachable', { message: Schema.String }) {}

/** How a streamed reply from llama-server fails. */
export type ChatStreamFailure = LlamaHttpFailed | LlamaStreamFailed | LlamaStreamCut | LlamaUnreachable;

/**
 * One chunk of `/v1/chat/completions`, read field by field by `readChatChunk` of `llamacpp-js/client`: a field of
 * another type is left out, the others are kept (the delta survives timings that are not ones).
 */
export type ChatChunk = ChatCompletionChunk;

/**
 * What the data of one event says: a chunk, nothing (data that is not JSON is skipped; `[DONE]` never gets here), or
 * the stream's error.
 */
const chunkOf = (data: string): Effect.Effect<Option.Option<ChatChunk>, LlamaStreamFailed> => {
  const event = readChatEvent(data);
  if (event?.type === 'error') return Effect.fail(LlamaStreamFailed.make({ error: event.error }));
  return Effect.succeed(event?.type === 'chunk' ? Option.some(event.chunk) : Option.none());
};

const DONE = '[DONE]';

/**
 * The chunks of a streamed body until its `[DONE]`: a body that breaks, or ends without it, is `LlamaStreamCut`.
 */
const chunksOf = <E>(
  body: Stream.Stream<Uint8Array, E>,
): Stream.Stream<ChatChunk, LlamaStreamCut | LlamaStreamFailed> =>
  body.pipe(
    Stream.decodeText,
    Stream.pipeThroughChannel(Sse.decode()),
    Stream.mapError(() => LlamaStreamCut.make({})),
    Stream.concat(Stream.fail(LlamaStreamCut.make({}))),
    Stream.takeWhile((event) => event.data !== DONE),
    Stream.mapEffect((event) => chunkOf(event.data)),
    Stream.filterMap(Filter.fromPredicateOption(identity)),
  );

/** The message of a request that never got its answer: the cause's (`connect ECONNREFUSED …`), else the client's. */
const unreachable = (error: HttpClientError.HttpClientError): LlamaUnreachable => {
  const cause = error.reason.cause;
  // A deliberate change: the Nitro server's `llamaFetch` rejected with `fetch failed`, which named no reason.
  return LlamaUnreachable.make({
    message:
      Predicate.hasProperty(cause, 'message') && Predicate.isString(cause.message) ? cause.message : error.message,
  });
};

const isOk = (status: number) => status >= 200 && status < 300;

/**
 * One streamed `POST <baseUrl>/v1/chat/completions` with `body` as its JSON, through `LlamaHttp`: its chunks until
 * `[DONE]`. The request belongs to the stream: ending or interrupting the stream aborts it. An error status is
 * `LlamaHttpFailed`, an error event `LlamaStreamFailed`, a body that ends or breaks before `[DONE]` `LlamaStreamCut`,
 * and a request that never got its answer `LlamaUnreachable`. `body` is sent as it is: it must ask for a stream
 * (`stream: true`, as `buildChatRequest` of `chat/request.ts` builds it).
 */
export const streamChat: {
  (body: unknown): (baseUrl: string) => Stream.Stream<ChatChunk, ChatStreamFailure, LlamaHttp>;
  (baseUrl: string, body: unknown): Stream.Stream<ChatChunk, ChatStreamFailure, LlamaHttp>;
} = dual(2, (baseUrl: string, body: unknown): Stream.Stream<ChatChunk, ChatStreamFailure, LlamaHttp> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const client = yield* LlamaHttp;
      const request = yield* HttpClientRequest.post(`${baseUrl}/v1/chat/completions`).pipe(
        HttpClientRequest.bodyJson(body),
        Effect.orDie,
      );
      const res = yield* client.execute(request).pipe(Effect.mapError(unreachable));
      if (!isOk(res.status)) {
        const text = yield* res.text.pipe(Effect.orElseSucceed(() => ''));
        const error = Option.fromNullishOr(parseLlamaError(text));
        return yield* LlamaHttpFailed.make({ status: res.status, body: text, error });
      }
      return chunksOf(res.stream);
    }),
  ),
);
