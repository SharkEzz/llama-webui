import { Api, requestInvalid } from '@llama-webui/shared';
import { Cause, Effect, Exit, ManagedRuntime, Predicate, Schema, Stream } from 'effect';
import { FetchHttpClient, type HttpClient, HttpClientError } from 'effect/http';
import { type HttpApi, HttpApiClient, type HttpApiGroup } from 'effect/http-api';

/** A failed call that never reached the server. */
export class ApiUnreachable extends Error {
  readonly _tag = 'ApiUnreachable';
  constructor(options?: { cause?: unknown }) {
    super('llama-webui server unreachable', options);
    this.name = 'ApiUnreachable';
  }
}

/** A reply the page cannot read: an event of a stream that does not decode. The cause is logged. */
export class ApiReplyInvalid extends Error {
  readonly _tag = 'ApiReplyInvalid';
  constructor(options?: { cause?: unknown }) {
    super('llama-webui server sent a reply the page cannot read', options);
    this.name = 'ApiReplyInvalid';
  }
}

/**
 * What a stream's failure means to a page: a broken body (the server went away, the connection was cut) is
 * `ApiUnreachable`; an event that does not decode (its schema, the SSE framing, a retry directive) is
 * `ApiReplyInvalid`, logged, since reading it again would fail again; the endpoint's own stream errors stay as they are.
 */
const streamFailure = <E>(e: E) => {
  if (HttpClientError.isHttpClientError(e)) return new ApiUnreachable({ cause: e });
  if (Schema.isSchemaError(e) || Predicate.isTagged(e, 'SseError') || Predicate.isTagged(e, 'Retry')) {
    console.error('llama-webui: an event of the reply does not decode', e);
    return new ApiReplyInvalid({ cause: e });
  }
  return e;
};

/** The one runtime of the web's calls: Effect's HTTP client on `fetch`. */
const runtime = ManagedRuntime.make(FetchHttpClient.layer);

/**
 * The client of `api` running `f`, its errors as a page reads them: the endpoint's tagged error as the server sent
 * it, `ApiUnreachable` for a request that got no answer, and for a payload the client refuses to send (it encodes it
 * with the endpoint's schema first) the `RequestInvalid` the server would have answered.
 */
function request<Groups extends HttpApiGroup.Constraint, A, E>(
  api: HttpApi.HttpApi<string, Groups>,
  f: (client: HttpApiClient.Client<Groups>) => Effect.Effect<A, E>,
) {
  return HttpApiClient.make(api).pipe(
    Effect.flatMap(f),
    // The request never got an answer (refused, network down, DNS): the server is unreachable.
    Effect.catchIf(
      (e) => HttpClientError.isHttpClientError(e) && e.reason._tag === 'TransportError',
      (e) => Effect.fail(new ApiUnreachable({ cause: e })),
    ),
    // The payload did not encode: no request was made, the caller sees what the server answers such a payload.
    Effect.mapError((e) => (Schema.isSchemaError(e) ? requestInvalid(e.issue) : e)),
    // The web's APIs declare no client middleware: the client needs nothing but the HTTP client, which TypeScript
    // cannot tell for a generic `Groups`.
  ) as Effect.Effect<A, E | ApiUnreachable, HttpClient.HttpClient>;
}

/** Runs a call on the web's runtime, on `fetchImpl` when a test gives one, stopped by `signal`. */
function run<A, E>(
  effect: Effect.Effect<A, E, HttpClient.HttpClient>,
  fetchImpl: typeof fetch | undefined,
  signal: AbortSignal | undefined,
) {
  return runtime.runPromiseExit(
    fetchImpl ? effect.pipe(Effect.provideService(FetchHttpClient.Fetch, fetchImpl)) : effect,
    signal ? { signal } : undefined,
  );
}

/**
 * One call of an API: resolves with the decoded reply, rejects with the endpoint's tagged error or `ApiUnreachable`
 * (see `request`). `fetchImpl` replaces `fetch` in tests.
 */
export function makeCall<Id extends string, Groups extends HttpApiGroup.Constraint>(
  api: HttpApi.HttpApi<Id, Groups>,
  fetchImpl?: typeof fetch,
) {
  return async <A, E>(
    f: (client: HttpApiClient.Client<Groups>) => Effect.Effect<A, E>,
    options?: { signal?: AbortSignal },
  ): Promise<A> => {
    const exit = await run(request(api, f), fetchImpl, options?.signal);
    if (Exit.isSuccess(exit)) return exit.value;
    throw Cause.squash(exit.cause);
  };
}

/**
 * One call of an endpoint that answers a stream (server-sent events): `onEvent` gets each event in order, and the
 * promise resolves when the stream ends. It rejects as `call` does, then as `streamFailure` says: `ApiUnreachable` when
 * the stream breaks off, `ApiReplyInvalid` when an event does not decode. An abort of `signal` (before the response or
 * during the stream) ends it without an error, the request aborted.
 */
export function makeCallStream<Id extends string, Groups extends HttpApiGroup.Constraint>(
  api: HttpApi.HttpApi<Id, Groups>,
  fetchImpl?: typeof fetch,
) {
  return async <A, E, E2>(
    f: (client: HttpApiClient.Client<Groups>) => Effect.Effect<Stream.Stream<A, E2>, E>,
    onEvent: (a: A) => void,
    options?: { signal?: AbortSignal },
  ): Promise<void> => {
    const follow = Effect.flatMap(request(api, f), (stream) =>
      stream.pipe(
        Stream.runForEach((a) => Effect.sync(() => onEvent(a))),
        Effect.mapError(streamFailure),
      ),
    );
    const exit = await run(follow, fetchImpl, options?.signal);
    if (Exit.isSuccess(exit) || Cause.hasInterruptsOnly(exit.cause)) return;
    throw Cause.squash(exit.cause);
  };
}

/** `call((api) => api.health.get())` */
export const call = makeCall(Api);

/** `callStream((api) => api.chat.send({ params, payload }), onEvent, { signal })` */
export const callStream = makeCallStream(Api);

/** The `_tag` of what a call rejected with, if it has one. */
export function errorTag(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && '_tag' in error && typeof error._tag === 'string'
    ? error._tag
    : undefined;
}
