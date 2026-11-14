import { assert, layer } from '@effect/vitest';
import { Api, DEFAULT_SETTINGS } from '@llama-webui/shared';
import { Effect, Layer } from 'effect';
import { HttpServer } from 'effect/http';
import { HttpApiTest } from 'effect/http-api';
import { CollectorsNotApplied } from '../collectors/Collectors.ts';
import * as Db from '../db/Db.ts';
import { RequestErrorsLive } from '../http/RequestErrors.ts';
import { Monitor } from '../monitor/Monitor.ts';
import { SettingsHandlers } from './http.ts';
import { SettingsRepo } from './SettingsRepo.ts';

const makeClient = HttpApiTest.groups(Api, ['settings']);

/** The handlers on a new in-memory database and `monitor`; the repository kept for what a test checks behind them. */
const handlersOn = (monitor: Layer.Layer<Monitor>) =>
  Layer.mergeAll(
    SettingsHandlers.pipe(
      Layer.provideMerge(Layer.merge(SettingsRepo.layer, monitor)),
      Layer.provide(Db.layerAt(':memory:')),
      Layer.provideMerge(RequestErrorsLive),
    ),
    HttpServer.layerServices,
  );

/** A monitor that refuses every change of the settings, as the collectors do when one of their parts breaks. */
const Refusing = Layer.effect(
  Monitor,
  Effect.gen(function* () {
    const stub = yield* Monitor;
    return Monitor.of({
      ...stub,
      configure: () => Effect.fail(CollectorsNotApplied.make({ message: 'NVML init failed' })),
    });
  }),
).pipe(Layer.provide(Monitor.layerStub));

layer(handlersOn(Monitor.layerStub))('SettingsApi', (it) => {
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

layer(handlersOn(Refusing))('SettingsApi with a monitor that refuses the change', (it) => {
  it.effect('PATCH /api/settings: saved but not applied by the monitor is a 200 with a warning, not a 500 (#35)', () =>
    Effect.gen(function* () {
      const client = yield* makeClient;
      const patched = yield* client.settings.patch({ payload: { port: 9000 } });
      assert.strictEqual(patched.port, 9000);
      assert.strictEqual(patched.warning, 'Saved, but the monitor could not apply it: NVML init failed');
      assert.strictEqual((yield* (yield* SettingsRepo).get).port, 9000);
    }),
  );
});
