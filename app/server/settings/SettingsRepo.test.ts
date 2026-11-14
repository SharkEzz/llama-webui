import { assert, describe, it } from '@effect/vitest';
import { DEFAULT_SETTINGS } from '@llama-webui/shared';
import { Array as Arr, Effect, Layer } from 'effect';
import { SqlClient } from 'effect/sql';
import * as Db from '../db/Db.ts';
import { SettingsRepo } from './SettingsRepo.ts';

/** A repository on a new in-memory database, with its client for what the test stores itself. */
const Fresh = SettingsRepo.layer.pipe(Layer.provideMerge(Db.layerAt(':memory:')));

/** `test` on its own new database. */
const fresh = <A, E>(test: Effect.Effect<A, E, SettingsRepo | SqlClient.SqlClient>) =>
  Layer.build(Fresh).pipe(
    Effect.flatMap((context) => Effect.provideContext(test, context)),
    Effect.scoped,
  );

describe('SettingsRepo', () => {
  it.effect('settings: defaults, then a persisted patch', () =>
    fresh(
      Effect.gen(function* () {
        const repo = yield* SettingsRepo;
        const initial = yield* repo.get;
        assert.deepStrictEqual(initial, DEFAULT_SETTINGS);
        const patched = yield* repo.patch({ port: 9000 });
        assert.strictEqual(patched.port, 9000);
        const read = yield* repo.get;
        assert.strictEqual(read.port, 9000);
        const refused = yield* Effect.flip(repo.patch({ pollIntervalMs: 10 }));
        assert.strictEqual(refused._tag, 'SettingsInvalid');
      }),
    ),
  );

  it.effect('settings: a stored value that became invalid falls back to the default and can be repaired', () =>
    fresh(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO settings(key, value_json) VALUES ('port', '"bad"'), ('pollIntervalMs', '10')`;
        const repo = yield* SettingsRepo;
        const read = yield* repo.get;
        assert.strictEqual(read.port, DEFAULT_SETTINGS.port);
        assert.strictEqual(read.pollIntervalMs, DEFAULT_SETTINGS.pollIntervalMs);
        const repaired = yield* repo.patch({ port: 9001 });
        assert.strictEqual(repaired.port, 9001);
      }),
    ),
  );

  it.effect('settings: llama-server listens on loopback by default, like llama-webui (#27)', () =>
    fresh(
      Effect.gen(function* () {
        const repo = yield* SettingsRepo;
        const read = yield* repo.get;
        assert.strictEqual(read.host, '127.0.0.1');
      }),
    ),
  );

  it.effect('settings: env is replaced as a whole (a variable left out is removed) and its names are checked', () =>
    fresh(
      Effect.gen(function* () {
        const repo = yield* SettingsRepo;
        yield* repo.patch({ env: { A: '1', B: '2' } });
        const patched = yield* repo.patch({ env: { B: '3' } });
        assert.deepStrictEqual(patched.env, { B: '3' });
        const read = yield* repo.get;
        assert.deepStrictEqual(read.env, { B: '3' });
        const refused = yield* Effect.flip(repo.patch({ env: { '1BAD': 'x' } }));
        assert.deepStrictEqual(
          Arr.map(refused.issues, (i) => i.message),
          ['invalid variable name “1BAD”'],
        );
      }),
    ),
  );

  it.effect('an object setting is merged field by field (#35)', () =>
    fresh(
      Effect.gen(function* () {
        const repo = yield* SettingsRepo;
        yield* repo.patch({ collectors: { nvml: false } });
        const patched = yield* repo.patch({ collectors: { disk: false } });
        assert.deepStrictEqual(patched.collectors, { nvml: false, system: true, disk: false });
      }),
    ),
  );

  it.effect('a key that is not a setting is ignored', () =>
    fresh(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const repo = yield* SettingsRepo;
        const next = yield* repo.patch({ nope: 3, port: 9002 });
        assert.strictEqual(next.port, 9002);
        assert.isFalse('nope' in next);
        const keys = yield* sql<{ readonly key: string }>`SELECT key FROM settings ORDER BY key`;
        assert.deepStrictEqual(
          Arr.map(keys, (r) => r.key),
          ['port'],
        );
      }),
    ),
  );

  it.effect('a patch that is invalid writes nothing and names the field', () =>
    fresh(
      Effect.gen(function* () {
        const repo = yield* SettingsRepo;
        const refused = yield* Effect.flip(repo.patch({ port: 70000, theme: 'dark' }));
        assert.strictEqual(refused._tag, 'SettingsInvalid');
        assert.strictEqual(refused.message, 'Invalid settings');
        assert.deepStrictEqual(refused.issues, [{ path: ['port'], message: 'Port between 1 and 65535' }]);
        const read = yield* repo.get;
        assert.strictEqual(read.theme, 'system');
      }),
    ),
  );
});
