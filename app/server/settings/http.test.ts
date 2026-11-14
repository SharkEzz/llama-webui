import { assert, layer } from '@effect/vitest';
import { Api, DEFAULT_SETTINGS } from '@llama-webui/shared';
import { Effect, Layer } from 'effect';
import { HttpServer } from 'effect/http';
import { HttpApiTest } from 'effect/http-api';
import * as Db from '../db/Db.ts';
import { SettingsHandlers } from './http.ts';
import { SettingsRepo } from './SettingsRepo.ts';

const makeClient = HttpApiTest.groups(Api, ['settings']);

const Handlers = SettingsHandlers.pipe(Layer.provide(SettingsRepo.layer), Layer.provide(Db.layerAt(':memory:')));

layer(Layer.mergeAll(Handlers, HttpServer.layerServices))('SettingsApi', (it) => {
  it.effect('GET gives the settings, PATCH the settings after the patch', () =>
    Effect.gen(function* () {
      const client = yield* makeClient;
      const initial = yield* client.settings.get();
      assert.deepStrictEqual(initial, DEFAULT_SETTINGS);
      const patched = yield* client.settings.patch({ payload: { theme: 'dark', collectors: { nvml: false } } });
      assert.strictEqual(patched.theme, 'dark');
      assert.deepStrictEqual(patched.collectors, { nvml: false, system: true, disk: true });
      const read = yield* client.settings.get();
      assert.deepStrictEqual(read, patched);
    }),
  );

  it.effect('PATCH with an invalid field fails with SettingsInvalid', () =>
    Effect.gen(function* () {
      const client = yield* makeClient;
      const refused = yield* Effect.flip(client.settings.patch({ payload: { historySeconds: 5 } }));
      assert(refused._tag === 'SettingsInvalid');
      assert.deepStrictEqual(refused.issues, [{ path: ['historySeconds'], message: 'Between 30 and 1800 s' }]);
    }),
  );

  it.effect('pollIntervalMs is capped at 60 s (#37)', () =>
    Effect.gen(function* () {
      const client = yield* makeClient;
      assert.strictEqual(
        (yield* client.settings.patch({ payload: { pollIntervalMs: 60_000 } })).pollIntervalMs,
        60_000,
      );
      const refused = yield* Effect.flip(client.settings.patch({ payload: { pollIntervalMs: 3_600_000 } }));
      assert(refused._tag === 'SettingsInvalid');
      assert.strictEqual((yield* client.settings.get()).pollIntervalMs, 60_000);
      assert.strictEqual(DEFAULT_SETTINGS.pollIntervalMs, 1000);
    }),
  );
});
