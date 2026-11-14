import { assert, layer } from '@effect/vitest';
import { P2P_LOG_LINE, type Profile, type ProfileInput } from '@llama-webui/shared';
import { Array as Arr, Effect, Path, String as Str } from 'effect';
import { commandOf, launchLines, profilePaths } from './command.ts';

const settings = { binary: 'llama-server', host: '0.0.0.0', port: 8080, env: {} };
const p = (input: Omit<ProfileInput, 'args' | 'env'> & Partial<Pick<ProfileInput, 'args' | 'env'>>): Profile => ({
  args: [],
  env: {},
  ...input,
  id: 1,
  source: 'ui',
  createdAt: 0,
  updatedAt: 0,
});
const HOME = '/home/x';
const CWD = '/srv/llama-webui';

/** `commandOf` with the home and working directory of these tests, and no `GGML_CUDA_P2P` in the environment. */
const commandWith = (profile: Profile, overrides: Partial<typeof settings> & { p2pInEnvironment?: boolean } = {}) =>
  Effect.map(Path.Path, (path) => {
    const { p2pInEnvironment = false, ...own } = overrides;
    return commandOf({ profile, settings: { ...settings, ...own }, home: HOME, cwd: CWD, p2pInEnvironment, path });
  });

layer(Path.layer)('command', (it) => {
  it.effect('builds argv with pdeathsig and mandatory flags', () =>
    Effect.gen(function* () {
      const cmd = yield* commandWith(
        p({ name: 'q', model: 'm.gguf', mmproj: 'p.gguf', cwd: '~/Models', args: ['-c', '40000'] }),
      );
      assert.deepStrictEqual(cmd.argv, [
        'setpriv',
        '--pdeathsig',
        'KILL',
        '--',
        'llama-server',
        '-m',
        'm.gguf',
        '-mm',
        'p.gguf',
        '-c',
        '40000',
        '-lv',
        '4',
        '--host',
        '0.0.0.0',
        '--port',
        '8080',
        '--metrics',
        '--slots',
        '--props',
      ]);
      assert.strictEqual(cmd.cwd, '/home/x/Models');
      assert.strictEqual(cmd.port, 8080);
      assert.strictEqual(cmd.host, '0.0.0.0');
      assert.strictEqual(cmd.profileName, 'q');
      assert.strictEqual(cmd.profileId, 1);
    }),
  );

  it.effect('~ in model and mmproj is expanded for llama-server, which runs without a shell', () =>
    Effect.gen(function* () {
      const cmd = yield* commandWith(p({ name: 'q', model: '~/Models/m.gguf', mmproj: '~/Models/p.gguf' }));
      assert.deepStrictEqual(Arr.take(Arr.drop(cmd.argv, 5), 4), [
        '-m',
        '/home/x/Models/m.gguf',
        '-mm',
        '/home/x/Models/p.gguf',
      ]);
      assert.include(cmd.display, '-m /home/x/Models/m.gguf');
    }),
  );

  it.effect('profilePaths: the files as llama-server opens them, from its cwd, ~ expanded everywhere', () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const paths = (profile: Pick<Profile, 'model' | 'mmproj' | 'cwd'>) =>
        profilePaths({ profile, home: HOME, cwd: CWD, path });
      assert.deepStrictEqual(paths({ model: 'm.gguf', mmproj: 'sub/p.gguf', cwd: '~/Models' }), {
        cwd: '/home/x/Models',
        model: '/home/x/Models/m.gguf',
        mmproj: '/home/x/Models/sub/p.gguf',
      });
      assert.deepStrictEqual(paths({ model: '~/Models/m.gguf' }), {
        cwd: CWD,
        model: '/home/x/Models/m.gguf',
        mmproj: null,
      });
      assert.strictEqual(paths({ model: '/abs/m.gguf', cwd: '/elsewhere' }).model, '/abs/m.gguf');
    }),
  );

  it.effect('profile port/host override server', () =>
    Effect.gen(function* () {
      const cmd = yield* commandWith(p({ name: 'q', model: 'm', host: '127.0.0.1', port: 8091 }));
      assert.include(Arr.join(cmd.argv, ' '), '--host 127.0.0.1 --port 8091');
      assert.strictEqual(cmd.port, 8091);
    }),
  );

  it.effect('display omits setpriv prefix and quotes spaces', () =>
    Effect.gen(function* () {
      const cmd = yield* commandWith(p({ name: 'q', model: 'm.gguf', args: ['--alias', 'a b'] }));
      assert.isTrue(Str.startsWith('llama-server -m m.gguf')(cmd.display));
      assert.include(cmd.display, "'a b'");
    }),
  );

  it.effect('the settings variables then the profile ones are laid over the environment', () =>
    Effect.gen(function* () {
      const cmd = yield* commandWith(p({ name: 'q', model: 'm', env: { FOO: '1', BOTH: 'profile' } }), {
        env: { BAR: '2', BOTH: 'settings' },
      });
      assert.deepStrictEqual(cmd.env, { BAR: '2', BOTH: 'profile', FOO: '1' });
    }),
  );

  it.effect('cwd defaults to process.cwd()', () =>
    Effect.gen(function* () {
      const cmd = yield* commandWith(p({ name: 'q', model: 'm' }));
      assert.strictEqual(cmd.cwd, CWD);
    }),
  );

  it.effect('adds -lv 4 so the buffer sizes are logged, unless the profile sets a verbosity (#16)', () =>
    Effect.gen(function* () {
      const argv = (args: Array<string>, env: Record<string, string> = {}) =>
        Effect.map(commandWith(p({ name: 'q', model: 'm.gguf', args, env })), (cmd) => Arr.join(cmd.argv, ' '));
      const plain = yield* argv([]);
      assert.include(plain, ' -lv 4 --host');
      const own = yield* Effect.forEach(
        [['-lv', '2'], ['--verbosity', '5'], ['--log-verbosity=1'], ['-v'], ['--verbose']],
        (args) => argv(args),
      );
      for (const line of own) assert.notInclude(line, '-lv 4');
      const byEnv = yield* argv([], { LLAMA_ARG_LOG_VERBOSITY: '3' });
      assert.notInclude(byEnv, '-lv 4');
    }),
  );

  it.effect('the binary setting is run with ~ expanded (#32)', () =>
    Effect.gen(function* () {
      const profile = p({ name: 'q', model: 'm.gguf' });
      const built = yield* commandWith(profile, { binary: '~/llama.cpp/build/bin/llama-server' });
      const bare = yield* commandWith(profile, { binary: 'llama-server' });
      const other = yield* commandWith(profile, { binary: '~/b/llama-server' });
      assert.strictEqual(built.argv[4], '/home/x/llama.cpp/build/bin/llama-server');
      assert.strictEqual(bare.argv[4], 'llama-server');
      assert.strictEqual(other.argv[4], '/home/x/b/llama-server');
    }),
  );

  it.effect(
    'launchLines: the launch line, plus the peer-to-peer one when GGML_CUDA_P2P is set, whatever its value',
    () =>
      Effect.gen(function* () {
        const plain = yield* commandWith(p({ name: 'q', model: 'm.gguf' }));
        assert.deepStrictEqual(launchLines(plain), [`[llama-webui] launch: ${plain.display}`]);
        // llama.cpp only checks that the variable exists: an empty value enables it too.
        const set = yield* Effect.forEach(['1', '0', ''], (value) =>
          commandWith(p({ name: 'q', model: 'm.gguf', env: { GGML_CUDA_P2P: value } })),
        );
        const inSettings = yield* commandWith(p({ name: 'q', model: 'm.gguf' }), { env: { GGML_CUDA_P2P: '1' } });
        const inEnvironment = yield* commandWith(p({ name: 'q', model: 'm.gguf' }), { p2pInEnvironment: true });
        for (const cmd of [...set, inSettings, inEnvironment]) {
          assert.deepStrictEqual(launchLines(cmd), [`[llama-webui] launch: ${cmd.display}`, P2P_LOG_LINE]);
        }
      }),
  );

  it.effect('the settings variables are in the environment, under the profile ones, and can set the verbosity', () =>
    Effect.gen(function* () {
      const cmd = yield* commandWith(p({ name: 'q', model: 'm.gguf', env: { GGML_CUDA_P2P: '0', B: 'profile' } }), {
        env: { GGML_CUDA_P2P: '1', A: 'global', LLAMA_ARG_LOG_VERBOSITY: '3' },
      });
      assert.deepStrictEqual(cmd.env, { A: 'global', B: 'profile', GGML_CUDA_P2P: '0', LLAMA_ARG_LOG_VERBOSITY: '3' });
      assert.notInclude(cmd.argv, '-lv');
    }),
  );

  it.effect('a stored profile is launched with its arguments as stored, a reserved flag included', () =>
    Effect.gen(function* () {
      // `ProfileInput` refuses `--port` on a write; a row read back has no input rule.
      const cmd = yield* commandWith(p({ name: 'q', model: 'm.gguf', args: ['--port', '9000', '-c', '512'] }));
      assert.include(Arr.join(cmd.argv, ' '), '-m m.gguf --port 9000 -c 512 -lv 4 --host 0.0.0.0 --port 8080');
    }),
  );
});
