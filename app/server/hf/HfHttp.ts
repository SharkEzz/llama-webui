import * as NodeHttpClient from '@effect/platform-node/NodeHttpClient';
import { Context, Effect, Layer, type Scope } from 'effect';
import { HttpClient, type HttpClientError } from 'effect/http';
import { isTestOffline, offlineClient, proxyEnv } from '../http/proxyEnv.ts';

/**
 * The HTTP client of every request to Hugging Face (the Hub's API, the downloads): `node:http` and `node:https` on
 * agents of its own (HTTP/1.1: the HTTP/2 window of Hugging Face capped a stream at ~22 MiB/s), kept alive, through the
 * proxy of the environment (loopback and `NO_PROXY` direct), with no time limit of its own (each caller bounds what it
 * waits for) and no redirect followed. Each request belongs to the scope of its caller, which aborts it when it closes.
 * With `LLAMA_WEBUI_TEST_OFFLINE=1` (exact value) nothing leaves the machine: every request fails with `fetch failed`.
 */
export class HfHttp extends Context.Service<
  HfHttp,
  HttpClient.HttpClient.With<HttpClientError.HttpClientError, Scope.Scope>
>()('@llama-webui/app/server/hf/HfHttp') {
  static readonly layer: Layer.Layer<HfHttp> = Layer.unwrap(
    Effect.gen(function* () {
      if (yield* isTestOffline) return Layer.succeed(HfHttp, HttpClient.withScope(offlineClient));
      const agents = { keepAlive: true, proxyEnv: yield* proxyEnv };
      return Layer.effect(HfHttp, Effect.map(HttpClient.HttpClient, HttpClient.withScope)).pipe(
        Layer.provide(NodeHttpClient.layerNodeHttpOptions(agents)),
      );
    }).pipe(Effect.orDie),
  );
}
