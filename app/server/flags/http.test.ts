import { assert, layer } from '@effect/vitest';
import { Api } from '@llama-webui/shared';
import { Effect, Layer, Path } from 'effect';
import { HttpServer } from 'effect/http';
import { HttpApiTest } from 'effect/http-api';
import { SettingsRepo } from '../settings/SettingsRepo.ts';
import { ServicesTest } from '../testing/services.ts';
import { FlagsHandlers } from './http.ts';

const makeClient = HttpApiTest.groups(Api, ['flags']);

/** The handlers on the services of the app, for the typed client. */
const Handlers = Layer.mergeAll(FlagsHandlers.pipe(Layer.provideMerge(ServicesTest)), HttpServer.layerServices);

/** The fake llama-server of the repository, as the `binary` setting. */
const useFake = Effect.gen(function* () {
  const path = yield* Path.Path;
  const settings = yield* SettingsRepo;
  const binary = path.resolve(import.meta.dirname, '../../../testdata/fake/fake-llama-server');
  yield* settings.patch({ binary });
});

layer(Handlers)('FlagsApi', (it) => {
  it.effect('GET /api/flags answers the flags of the fake llama-server', () =>
    Effect.gen(function* () {
      yield* useFake;
      const client = yield* makeClient;
      const { flags } = yield* client.flags.get();
      assert.isAbove(flags.length, 0);
      for (const flag of flags) {
        assert.isAbove(flag.names.length, 0);
        assert.isString(flag.help);
        assert.isString(flag.section);
      }
    }),
  );

  it.effect('GET /api/flags fails with FlagsUnavailable for a binary that is not there', () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const binary = path.resolve(import.meta.dirname, 'no-such-llama-server');
      const settings = yield* SettingsRepo;
      yield* settings.patch({ binary });
      const client = yield* makeClient;
      const refused = yield* Effect.flip(client.flags.get());
      assert(refused._tag === 'FlagsUnavailable');
      assert.strictEqual(refused.message, `llama-server --help failed (${binary})`);
    }),
  );
});
