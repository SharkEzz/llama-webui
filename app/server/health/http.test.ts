import { assert, layer } from '@effect/vitest';
import { Api } from '@llama-webui/shared';
import { Effect, Layer } from 'effect';
import { HttpServer } from 'effect/http';
import { HttpApiTest } from 'effect/http-api';
import { AppInfo } from '../config/AppInfo.ts';
import { RequestErrorsLive } from '../http/RequestErrors.ts';
import { HealthHandlers } from './http.ts';

const makeClient = HttpApiTest.groups(Api, ['health']);

layer(
  Layer.mergeAll(
    HealthHandlers.pipe(Layer.provide(AppInfo.layer), Layer.provideMerge(RequestErrorsLive)),
    HttpServer.layerServices,
  ),
)('HealthApi', (it) => {
  it.effect('health answers ok with the version, the uptime and the bootId', () =>
    Effect.gen(function* () {
      const client = yield* makeClient;
      const first = yield* client.health.get();
      const second = yield* client.health.get();
      assert.strictEqual(first.ok, true);
      assert.strictEqual(first.version, 'dev');
      assert.isAtLeast(first.uptimeMs, 0);
      assert.strictEqual(second.bootId, first.bootId);
    }),
  );
});
