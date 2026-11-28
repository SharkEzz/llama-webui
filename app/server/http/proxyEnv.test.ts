import { assert, describe, it } from '@effect/vitest';
import { ConfigProvider, Effect } from 'effect';
import { HttpClientRequest } from 'effect/http';
import { offlineClient, proxyEnv } from './proxyEnv.ts';

const readProxy = (env: Record<string, string>) => proxyEnv.parse(ConfigProvider.fromEnv({ env }));

describe('proxyEnv', () => {
  it.effect('always includes loopback in NO_PROXY and no_proxy when no proxy is configured', () =>
    Effect.gen(function* () {
      const env = yield* readProxy({});
      assert.deepStrictEqual(env, {
        no_proxy: 'localhost,127.0.0.1,::1',
        NO_PROXY: 'localhost,127.0.0.1,::1',
      });
    }),
  );

  it.effect('reads proxy variables (both cases), skips empty ones, and appends loopback to NO_PROXY', () =>
    Effect.gen(function* () {
      const env = yield* readProxy({
        HTTP_PROXY: 'http://proxy:8080',
        https_proxy: 'http://secure:8443',
        HTTPS_PROXY: '',
        NO_PROXY: 'internal.local,.corp',
      });
      assert.deepStrictEqual(env, {
        HTTP_PROXY: 'http://proxy:8080',
        https_proxy: 'http://secure:8443',
        no_proxy: 'internal.local,.corp,localhost,127.0.0.1,::1',
        NO_PROXY: 'internal.local,.corp,localhost,127.0.0.1,::1',
      });
    }),
  );

  it.effect('prefers lowercase no_proxy over NO_PROXY when both are set', () =>
    Effect.gen(function* () {
      const env = yield* readProxy({ no_proxy: 'a.local', NO_PROXY: 'b.local' });
      assert.strictEqual(env.no_proxy, 'a.local,localhost,127.0.0.1,::1');
      assert.strictEqual(env.NO_PROXY, 'a.local,localhost,127.0.0.1,::1');
    }),
  );

  it.effect('offlineClient fails every request with a TransportError described as fetch failed', () =>
    Effect.gen(function* () {
      const error = yield* offlineClient.execute(HttpClientRequest.get('http://example.invalid')).pipe(Effect.flip);
      assert.strictEqual(error.reason._tag, 'TransportError');
      assert.strictEqual(error.reason._tag === 'TransportError' ? error.reason.description : null, 'fetch failed');
    }),
  );
});
