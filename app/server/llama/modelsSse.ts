import type { LoadProgress } from '@llama-webui/shared';
import { Effect, Filter, Option, Predicate, Schema, Stream } from 'effect';
import { Sse } from 'effect/encoding';
import { identity } from 'effect/Function';
import { type HttpClientError, HttpClientRequest } from 'effect/http';
import { probeUrl } from 'llamacpp-js/client';
import { type ModelLoadProgress, type ModelsSseEvent, parseModelsSseEvent } from 'llamacpp-js/models';
import { LlamaHttp } from './LlamaHttp.ts';
import type { Target } from './probes.ts';

/**
 * llama-server answered `/models/sse` with a non-2xx status (404 once loaded or 503 while loading on builds before
 * llama.cpp PR #32398): the caller falls back to `/health` polling.
 */
export class ModelsSseUnsupported extends Schema.TaggedError<
  ModelsSseUnsupported,
  { readonly ModelsSseUnsupported: unique symbol }
>()('ModelsSseUnsupported', { status: Schema.Int }) {}

/** Nothing answered `/models/sse` before the headers (e.g. ECONNREFUSED while llama-server is starting its listener). */
export class ModelsSseUnreachable extends Schema.TaggedError<
  ModelsSseUnreachable,
  { readonly ModelsSseUnreachable: unique symbol }
>()('ModelsSseUnreachable', { message: Schema.String }) {}

/** The `/models/sse` transport broke mid-stream. */
export class ModelsSseCut extends Schema.TaggedError<ModelsSseCut, { readonly ModelsSseCut: unique symbol }>()(
  'ModelsSseCut',
  {},
) {}

export type ModelsSseFailure = ModelsSseUnsupported | ModelsSseUnreachable | ModelsSseCut;

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

const unreachable = (error: HttpClientError.HttpClientError): ModelsSseUnreachable => {
  const cause = error.reason.cause;
  return ModelsSseUnreachable.make({
    message:
      Predicate.hasProperty(cause, 'message') && Predicate.isString(cause.message) ? cause.message : error.message,
  });
};

const isOk = (status: number) => status >= 200 && status < 300;

/** Clamps the value for schema encoding and preserves the current load's stage order on stage-only events. */
export const sanitizeLoadProgress = ({
  progress,
  previous,
}: {
  readonly progress: ModelLoadProgress;
  readonly previous?: LoadProgress | null;
}): LoadProgress => ({
  stages: progress.stages.length === 0 ? (previous?.stages ?? []) : [...progress.stages],
  current: progress.current,
  value: progress.value !== null && Number.isFinite(progress.value) ? Math.min(1, Math.max(0, progress.value)) : null,
});

const parseData = (data: string): Option.Option<ModelsSseEvent> =>
  decodeJson(data).pipe(Option.flatMap((json) => Option.fromNullishOr(parseModelsSseEvent(json))));

/**
 * Streams `GET <target>/models/sse` through `LlamaHttp`, yielding each recognized event until the server closes the
 * stream (clean EOF). Ending or interrupting the stream aborts the request. A non-2xx status (404/503 on older builds)
 * fails with `ModelsSseUnsupported`, a connection failure before headers with `ModelsSseUnreachable`, and a mid-stream
 * transport failure with `ModelsSseCut`.
 */
export const streamModelsSse = (target: Target): Stream.Stream<ModelsSseEvent, ModelsSseFailure, LlamaHttp> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const client = yield* LlamaHttp;
      const request = HttpClientRequest.get(`${probeUrl(target.host, target.port)}/models/sse`).pipe(
        HttpClientRequest.setHeader('accept', 'text/event-stream'),
      );
      const res = yield* client.execute(request).pipe(Effect.mapError(unreachable));
      if (!isOk(res.status)) {
        return yield* ModelsSseUnsupported.make({ status: res.status });
      }
      return res.stream.pipe(
        Stream.decodeText,
        Stream.pipeThroughChannel(Sse.decode()),
        Stream.mapError(() => ModelsSseCut.make({})),
        Stream.map((event) => parseData(event.data)),
        Stream.filterMap(Filter.fromPredicateOption(identity)),
      );
    }),
  );
