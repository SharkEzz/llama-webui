import { Api, requestInvalid } from '@llama-webui/shared';
import { Effect, ManagedRuntime, Schema } from 'effect';
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

/** The one runtime of the web's calls: Effect's HTTP client on `fetch`. */
const runtime = ManagedRuntime.make(FetchHttpClient.layer);

/**
 * One call of an API: resolves with the decoded reply, rejects with the endpoint's tagged error as the server sent
 * it, or with `ApiUnreachable`. A payload the client refuses to send (it encodes it with the endpoint's schema first)
 * rejects with the `RequestInvalid` the server would have answered. `fetchImpl` replaces `fetch` in tests.
 */
export function makeCall<Id extends string, Groups extends HttpApiGroup.Constraint>(
  api: HttpApi.HttpApi<Id, Groups>,
  fetchImpl?: typeof fetch,
) {
  return <A, E>(
    f: (client: HttpApiClient.Client<Groups>) => Effect.Effect<A, E>,
    options?: { signal?: AbortSignal },
  ): Promise<A> => {
    const call = HttpApiClient.make(api).pipe(
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
    return runtime.runPromise(
      fetchImpl ? call.pipe(Effect.provideService(FetchHttpClient.Fetch, fetchImpl)) : call,
      options?.signal ? { signal: options.signal } : undefined,
    );
  };
}

/** `call((api) => api.health.get())` */
export const call = makeCall(Api);

/** The `_tag` of what a call rejected with, if it has one. */
export function errorTag(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && '_tag' in error && typeof error._tag === 'string'
    ? error._tag
    : undefined;
}
