import type * as NodeHttpClient from '@effect/platform-node/NodeHttpClient';
import { Array as Arr, Config, Effect, Option, Record as Rec } from 'effect';
import { HttpClient, HttpClientError } from 'effect/http';

/** The variables that name a proxy, as Node's agents read them. */
const PROXY_KEYS = ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy'] as const;
/** Never proxied: a server on loopback is on this machine, and a proxy would look for it on its own. */
const LOOPBACK = ['localhost', '127.0.0.1', '::1'];

export type ProxyEnv = NonNullable<NodeHttpClient.HttpAgentOptions['proxyEnv']>;

/**
 * The proxy of the environment, for Node's HTTP agents: the proxy variables that are set (an empty one counts as
 * unset), and `no_proxy` (else `NO_PROXY`) with loopback always added, under both spellings.
 */
export const proxyEnv: Config.Config<ProxyEnv> = Config.all({
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
export const offlineClient: HttpClient.HttpClient = HttpClient.make((request) =>
  Effect.fail(
    new HttpClientError.HttpClientError({
      reason: new HttpClientError.TransportError({ request, description: 'fetch failed' }),
    }),
  ),
);

/** Whether `LLAMA_WEBUI_TEST_OFFLINE` is set to the exact value `'1'`. */
export const isTestOffline: Config.Config<boolean> = Config.option(Config.String('LLAMA_WEBUI_TEST_OFFLINE')).pipe(
  Config.map(Option.contains('1')),
);
