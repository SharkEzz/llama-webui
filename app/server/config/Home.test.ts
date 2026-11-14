import { assert, layer } from '@effect/vitest';
import { ConfigProvider, Effect, Path, String as Str } from 'effect';
import { expandHome, homeDir } from './Home.ts';

/** `effect` with `env` as the whole environment. */
const withEnv =
  (env: Record<string, string>) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.provideService(effect, ConfigProvider.ConfigProvider, ConfigProvider.fromEnv({ env }));

layer(Path.layer)('Home', (it) => {
  it.effect('expandHome expands ~ and ~/x, and nothing else', () =>
    Effect.gen(function* () {
      for (const [path, expanded] of [
        ['~', '/h'],
        ['~/bin/x', '/h/bin/x'],
        ['~x', '~x'],
        ['/a/~', '/a/~'],
        ['llama-server', 'llama-server'],
      ] as const) {
        const got = yield* expandHome(path).pipe(withEnv({ HOME: '/h' }));
        assert.strictEqual(got, expanded, path);
      }
    }),
  );

  it.effect('an empty HOME falls back to the system home', () =>
    Effect.gen(function* () {
      // The system's home (`homedir()`, from the user database when HOME is unset) is an absolute path.
      const system = yield* homeDir.pipe(withEnv({}));
      assert.isTrue(Str.startsWith('/')(system), system);
      const empty = yield* homeDir.pipe(withEnv({ HOME: '' }));
      assert.strictEqual(empty, system);
      const expanded = yield* expandHome('~/x').pipe(withEnv({ HOME: '' }));
      assert.strictEqual(expanded, `${system === '/' ? '' : system}/x`);
    }),
  );
});
