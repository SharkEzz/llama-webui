import { LlamaTimingsSchema } from '@llama-webui/shared';
import { Effect, Filter, Option, Predicate, Schema, Stream } from 'effect';
import { Sse } from 'effect/encoding';
import { dual, identity } from 'effect/Function';
import { type HttpClientError, HttpClientRequest } from 'effect/http';
import { LlamaHttp } from './LlamaHttp.ts';

/** The `error` object llama-server sends, in an HTTP error body or in a stream event (`LlamaError` of `llamacpp-js/errors`). */
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
 * One chunk of `/v1/chat/completions` as far as the chat reads it: the first choice's delta and the timings (absent
 * when they do not decode).
 */
export const ChatChunk = Schema.Struct({
  choices: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        delta: Schema.optionalKey(
          Schema.Struct({
            content: Schema.optionalKey(Schema.NullOr(Schema.String)),
            reasoning_content: Schema.optionalKey(Schema.NullOr(Schema.String)),
          }),
        ),
      }),
    ),
  ),
  // Timings that do not decode are dropped alone: the chunk keeps its delta.
  timings: Schema.optionalKey(LlamaTimingsSchema.pipe(Schema.catchDecoding(() => Effect.succeedNone))),
});
export type ChatChunk = typeof ChatChunk.Type;

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));
const decodeError = Schema.decodeUnknownOption(Schema.Struct({ error: LlamaError }));
const decodeChunk = Schema.decodeUnknownOption(ChatChunk);

/** The JSON error of an HTTP error body, when the body is llama-server JSON. */
const errorOfBody = (body: string): Option.Option<LlamaError> =>
  decodeJson(body).pipe(
    Option.flatMap(decodeError),
    Option.map((data) => data.error),
  );

/**
 * What the data of one event says: a chunk, nothing (a chunk that does not decode is skipped), or the stream's error.
 */
const chunkOf = (data: string): Effect.Effect<Option.Option<ChatChunk>, LlamaStreamFailed> => {
  const json = decodeJson(data);
  const error = Option.flatMap(json, decodeError);
  return Option.isSome(error)
    ? Effect.fail(LlamaStreamFailed.make({ error: error.value.error }))
    : Effect.succeed(Option.flatMap(json, decodeChunk));
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
} = dual(
  2,
  (baseUrl: string, body: unknown): Stream.Stream<ChatChunk, ChatStreamFailure, LlamaHttp> =>
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
          return yield* LlamaHttpFailed.make({ status: res.status, body: text, error: errorOfBody(text) });
        }
        return chunksOf(res.stream);
      }),
    ),
);
