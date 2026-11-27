import * as NodeHttpClient from '@effect/platform-node/NodeHttpClient';
import { Cause, Clock, Context, Duration, Effect, Exit, Layer, Metric, type Scope } from 'effect';
import { HttpClient, type HttpClientError, type HttpClientResponse } from 'effect/http';
import { LlamaHttpMetrics, statusClass } from '../runtime/Metrics.ts';

/** A request counted and timed to its headers by the class of its status, `failed` or `aborted`. */
const measured = Effect.fnUntraced(function* <E, R>(
  request: Effect.Effect<HttpClientResponse.HttpClientResponse, E, R>,
) {
  const started = yield* Clock.currentTimeMillis;
  const exit = yield* Effect.exit(request);
  const ended = yield* Clock.currentTimeMillis;
  const kind = Exit.isSuccess(exit)
    ? statusClass(exit.value.status)
    : Cause.hasInterruptsOnly(exit.cause)
      ? 'aborted'
      : 'failed';
  yield* Metric.update(Metric.withAttributes(LlamaHttpMetrics.requests, { class: kind }), 1);
  yield* Metric.update(
    Metric.withAttributes(LlamaHttpMetrics.duration, { class: kind }),
    Duration.millis(ended - started),
  );
  return yield* exit;
});

/**
 * The HTTP client of every request to a llama-server: `node:http` on its own agent, so always direct (the proxy of the
 * environment is for the outside world), no keep-alive, and no time limit of its own (a model may stay silent for
 * minutes; each caller bounds what it waits for). Each request belongs to the scope of its caller, which aborts it when
 * it closes: a reply whose body is not read holds no socket. Under its own tag: `HttpClient.HttpClient` is another
 * client's (the test server's in the HTTP tests, Hugging Face's at E6).
 */
export class LlamaHttp extends Context.Service<
  LlamaHttp,
  HttpClient.HttpClient.With<HttpClientError.HttpClientError, Scope.Scope>
>()('@llama-webui/app/server/llama/LlamaHttp') {
  static readonly layer: Layer.Layer<LlamaHttp> = Layer.effect(
    LlamaHttp,
    Effect.map(HttpClient.HttpClient, (client) => HttpClient.withScope(client).pipe(HttpClient.transform(measured))),
  ).pipe(Layer.provide(NodeHttpClient.layerNodeHttpOptions({ keepAlive: false })));
}
