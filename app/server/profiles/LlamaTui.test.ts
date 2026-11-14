import { NodeServices } from '@effect/platform-node';
import { assert, layer } from '@effect/vitest';
import { Array as Arr, ConfigProvider, Effect, FileSystem, Layer, Path, String as Str } from 'effect';
import { LlamaTui } from './LlamaTui.ts';

/** `effect` with `env` as the whole environment. */
const withEnv =
  (env: Record<string, string>) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.provideService(effect, ConfigProvider.ConfigProvider, ConfigProvider.fromEnv({ env }));

/** A config home of the test's own, and the path of the config in it, its folder made. */
const configHome = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* fs.makeTempDirectoryScoped({ prefix: 'lw-llamatui-' });
  const file = path.join(home, 'llama-tui', 'config.json');
  yield* fs.makeDirectory(path.dirname(file), { recursive: true });
  return { home, file };
});

/** The config read with `XDG_CONFIG_HOME` at `home`. */
const readAt = (home: string) =>
  Effect.gen(function* () {
    const tui = yield* LlamaTui;
    return yield* tui.read.pipe(withEnv({ XDG_CONFIG_HOME: home }));
  });

layer(LlamaTui.layer.pipe(Layer.provideMerge(NodeServices.layer)))('LlamaTui', (it) => {
  it.effect('the config is under XDG_CONFIG_HOME, else under the home', () =>
    Effect.gen(function* () {
      const tui = yield* LlamaTui;
      const xdg = yield* tui.path.pipe(withEnv({ XDG_CONFIG_HOME: '/x', HOME: '/h' }));
      assert.strictEqual(xdg, '/x/llama-tui/config.json');
      const unset = yield* tui.path.pipe(withEnv({ HOME: '/h' }));
      assert.strictEqual(unset, '/h/.config/llama-tui/config.json');
      const empty = yield* tui.path.pipe(withEnv({ XDG_CONFIG_HOME: '', HOME: '/h' }));
      assert.strictEqual(empty, '/h/.config/llama-tui/config.json');
    }),
  );

  it.effect('a missing config is not an error', () =>
    Effect.gen(function* () {
      const { home, file } = yield* configHome;
      const config = yield* readAt(home);
      assert.deepStrictEqual(config, {
        path: file,
        exists: false,
        defaultProfile: undefined,
        profiles: [],
        rejected: [],
      });
    }),
  );

  it.effect('a config is read: its profiles, its rejections and its default profile', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { home, file } = yield* configHome;
      yield* fs.copyFile('testdata/llama-tui-config.json', file);
      const config = yield* readAt(home);
      assert.isTrue(config.exists);
      assert.isUndefined(config.error);
      assert.deepStrictEqual(
        Arr.map(config.profiles, (profile) => profile.name),
        ['qwen3.8-27b-mtp', 'qwen3.8-27b-mtp (optimisé) (optimisé)'],
      );
      assert.deepStrictEqual(config.rejected, []);
      assert.strictEqual(config.defaultProfile, 'qwen3.8-27b-mtp');

      yield* fs.writeFileString(file, '{"defaultProfile":3,"profiles":[{"name":"a","model":"m"},{"name":"b"}]}');
      const other = yield* readAt(home);
      assert.isUndefined(other.defaultProfile);
      assert.deepStrictEqual(
        Arr.map(other.profiles, (profile) => profile.name),
        ['a'],
      );
      assert.deepStrictEqual(other.rejected, [{ name: 'b', reason: 'required (model)' }]);
    }),
  );

  it.effect('a config that is not JSON, not an object, a directory or unreadable has an error, not a failure', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { home, file } = yield* configHome;

      yield* fs.writeFileString(file, 'nope');
      const notJson = yield* readAt(home);
      assert.isTrue(notJson.exists);
      assert.strictEqual(notJson.error, 'Invalid JSON: Expected a valid JSON string');
      assert.deepStrictEqual(notJson.profiles, []);

      // JSON that is not a config: no error, the one rejection of a file that holds no profile.
      for (const text of ['[]', '3']) {
        yield* fs.writeFileString(file, text);
        const config = yield* readAt(home);
        assert.isTrue(config.exists, text);
        assert.isUndefined(config.error, text);
        assert.deepStrictEqual(
          config.rejected,
          text === '[]' ? [] : [{ name: '(file)', reason: 'no profile found in this JSON' }],
          text,
        );
      }

      // A directory at the path is not a config: as if it were missing (the Nitro server's `fileExists`).
      yield* fs.remove(file);
      yield* fs.makeDirectory(file);
      const directory = yield* readAt(home);
      assert.isFalse(directory.exists);
      assert.isUndefined(directory.error);
      yield* fs.remove(file, { recursive: true });

      // A file that cannot be read: root reads it anyway, so this half is for any other user.
      yield* fs.writeFileString(file, '{}');
      yield* fs.chmod(file, 0o000);
      const unreadable = yield* readAt(home);
      const root = yield* Effect.map(Effect.result(fs.readFileString(file)), (r) => r._tag === 'Success');
      if (!root) {
        assert.isTrue(unreadable.exists);
        assert.isTrue(Str.startsWith('Invalid JSON: PermissionDenied')(unreadable.error ?? ''), unreadable.error);
      }
      yield* fs.chmod(file, 0o644);
    }),
  );
});
