import * as NodeHttpClient from '@effect/platform-node/NodeHttpClient';
import { Array as Arr, Config, Context, Effect, Layer, Option, Record as Rec, type Scope } from 'effect';
import { HttpClient, HttpClientError } from 'effect/http';

/** The variables that name a proxy, as Node's agents read them. */
const PROXY_KEYS = ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy'] as const;
/** Never proxied: a server on loopback is on this machine, and a proxy would look for it on its own. */
const LOOPBACK = ['localhost', '127.0.0.1', '::1'];

type ProxyEnv = NonNullable<NodeHttpClient.HttpAgentOptions['proxyEnv']>;

/**
 * The proxy of the environment, for the agents: the proxy variables that are set (an empty one counts as unset), and
 * `no_proxy` (else `NO_PROXY`) with loopback always added, under both spellings.
 */
const proxyEnv: Config.Config<ProxyEnv> = Config.all({
  proxies: Config.all(Arr.map(PROXY_KEYS, (key) => Config.option(Config.String(key)))),
  none: Config.String('no_proxy').pipe(
    Config.orElse(() => Config.String('NO_PROXY')),
    Config.option,
  ),
}).pipe(
  Config.map(({ proxies, none }): ProxyEnv => {
    const set = Arr.getSomes(
      Arr.map(Arr.zip(PROXY_KEYS, proxies), ([key, value]) => Option.map(value, (proxy) => [key, proxy] as const)),
    );
    const noProxy = Arr.join([...Option.toArray(none), ...LOOPBACK], ',');
    return { ...Rec.fromEntries(set), no_proxy: noProxy, NO_PROXY: noProxy };
  }),
);

/** The client of `LLAMA_WEBUI_TEST_OFFLINE=1`: every request fails as Node's `fetch` failed without a network. */
const offline: HttpClient.HttpClient = HttpClient.make((request) =>
  Effect.fail(
    new HttpClientError.HttpClientError({
      reason: new HttpClientError.TransportError({ request, description: 'fetch failed' }),
    }),
  ),
);

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
      const mode = yield* Config.option(Config.String('LLAMA_WEBUI_TEST_OFFLINE'));
      if (Option.contains(mode, '1')) return Layer.succeed(HfHttp, HttpClient.withScope(offline));
      const agents = { keepAlive: true, proxyEnv: yield* proxyEnv };
      return Layer.effect(HfHttp, Effect.map(HttpClient.HttpClient, HttpClient.withScope)).pipe(
        Layer.provide(NodeHttpClient.layerNodeHttpOptions(agents)),
      );
    }).pipe(Effect.orDie),
  );
}
