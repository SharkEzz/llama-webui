import { NodeHttpClient } from '@effect/platform-node';
import { Context, Effect, Layer, type Scope } from 'effect';
import { HttpClient, type HttpClientError } from 'effect/http';

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
    Effect.map(HttpClient.HttpClient, HttpClient.withScope),
  ).pipe(Layer.provide(NodeHttpClient.layerNodeHttpOptions({ keepAlive: false })));
}
