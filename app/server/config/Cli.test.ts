import { NodeServices } from '@effect/platform-node';
import { assert, layer } from '@effect/vitest';
import { Array as Arr, ConfigProvider, Console, Context, Effect, Exit, Layer, Option, Ref } from 'effect';
import { CliOutput } from 'effect/cli';
import { TestConsole } from 'effect/testing';
import { AppConfig } from './AppConfig.ts';
import { type CliFlags, cliWith } from './Cli.ts';

const TestLayer = Layer.merge(NodeServices.layer, CliOutput.layer(CliOutput.defaultFormatter({ colors: false })));

/**
 * `llama-webui <args>` under `env`: how it ended, what `start` resolved (if it ran), and what it printed (a console of
 * its own per run).
 */
const run = Effect.fn('run')(function* (args: ReadonlyArray<string>, env: Record<string, string> = {}) {
  const started = yield* Ref.make(Option.none<AppConfig['Service'] & { readonly envOverride: boolean }>());
  const start = (flags: CliFlags) =>
    Layer.build(AppConfig.layerWith(flags)).pipe(
      Effect.map(Context.get(AppConfig)),
      Effect.flatMap((config) => Ref.set(started, Option.some({ ...config, envOverride: flags.envOverride }))),
      Effect.scoped,
    );
  const console = yield* TestConsole.make;
  const exit = yield* cliWith(start)(args).pipe(
    Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnv({ env })),
    Effect.provideService(Console.Console, console),
    Effect.exit,
  );
  const out = yield* TestConsole.logLines.pipe(Effect.provideService(Console.Console, console));
  const err = yield* TestConsole.errorLines.pipe(Effect.provideService(Console.Console, console));
  return {
    exit,
    started: yield* Ref.get(started),
    out: Arr.join(Arr.map(out, String), '\n'),
    err: Arr.join(Arr.map(err, String), '\n'),
  };
});

const help = run(['--help']).pipe(Effect.map(({ out }) => out));

layer(TestLayer)('cli', (it) => {
  it.effect('defaults without flag or env', () =>
    Effect.gen(function* () {
      const { exit, started } = yield* run([], { HOME: '/home/u' });
      assert.isTrue(Exit.isSuccess(exit));
      const config = Option.getOrThrow(started);
      assert.strictEqual(config.host, '127.0.0.1');
      assert.strictEqual(config.port, 7860);
      assert.strictEqual(config.dataDir, '/home/u/.local/share/llama-webui');
      assert.isFalse(config.envOverride);
    }),
  );

  it.effect('environment variables', () =>
    Effect.gen(function* () {
      const env = { LLAMA_WEBUI_HOST: '0.0.0.0', LLAMA_WEBUI_PORT: '8080', LLAMA_WEBUI_DATA_DIR: '/tmp/d' };
      const config = Option.getOrThrow((yield* run([], env)).started);
      assert.deepStrictEqual([config.host, config.port, config.dataDir], ['0.0.0.0', 8080, '/tmp/d']);
    }),
  );

  it.effect('a flag overrides the env, --opt=val form accepted', () =>
    Effect.gen(function* () {
      const env = { LLAMA_WEBUI_HOST: '0.0.0.0', LLAMA_WEBUI_PORT: '8080', LLAMA_WEBUI_DATA_DIR: '/tmp/d' };
      const { started } = yield* run(['--host', '192.168.0.20', '--port=9000', '--data-dir', '/srv/x'], env);
      const config = Option.getOrThrow(started);
      assert.deepStrictEqual([config.host, config.port, config.dataDir], ['192.168.0.20', 9000, '/srv/x']);
    }),
  );

  it.effect('an empty variable is ignored', () =>
    Effect.gen(function* () {
      const env = { HOME: '/home/u', LLAMA_WEBUI_HOST: '', LLAMA_WEBUI_PORT: '', LLAMA_WEBUI_DATA_DIR: '' };
      const config = Option.getOrThrow((yield* run([], env)).started);
      assert.deepStrictEqual(
        [config.host, config.port, config.dataDir],
        ['127.0.0.1', 7860, '/home/u/.local/share/llama-webui'],
      );
    }),
  );

  it.effect('--help and -h print the help and start nothing', () =>
    Effect.gen(function* () {
      for (const args of [['--help'], ['-h', '--port', 'nope']]) {
        const { exit, started, out } = yield* run(args);
        assert.isTrue(Exit.isSuccess(exit), Arr.join(args, ' '));
        assert.isTrue(Option.isNone(started), Arr.join(args, ' '));
        assert.include(out, 'llama-webui [options]');
      }
    }),
  );

  it.effect('invalid port, flag or env', () =>
    Effect.gen(function* () {
      for (const port of ['0', '70000', 'abc', '1.5']) {
        const flag = yield* run([`--port=${port}`]);
        assert.isTrue(Exit.isFailure(flag.exit), `--port=${port}`);
        assert.isTrue(Option.isNone(flag.started), `--port=${port}`);
        assert.include(flag.err, '--port', `--port=${port}`);
        const env = yield* run([], { HOME: '/home/u', LLAMA_WEBUI_PORT: port });
        assert.isTrue(Exit.isFailure(env.exit), `LLAMA_WEBUI_PORT=${port}`);
        assert.isTrue(Option.isNone(env.started), `LLAMA_WEBUI_PORT=${port}`);
        assert.include(String(Exit.isFailure(env.exit) && env.exit.cause), 'LLAMA_WEBUI_PORT');
      }
    }),
  );

  it.effect('unknown option, missing value, positional, empty value are refused', () =>
    Effect.gen(function* () {
      for (const args of [['--nope'], ['--host'], ['extra'], ['--host', ''], ['--data-dir=']]) {
        const { exit, started, out, err } = yield* run(args, { HOME: '/home/u' });
        assert.isTrue(Exit.isFailure(exit), Arr.join(args, ' '));
        assert.isTrue(Option.isNone(started), Arr.join(args, ' '));
        // The help, then the error.
        assert.include(out, 'USAGE', Arr.join(args, ' '));
        assert.include(err, 'ERROR', Arr.join(args, ' '));
      }
    }),
  );

  it.effect('--env-override is accepted and reaches start', () =>
    Effect.gen(function* () {
      const { started } = yield* run(['--env-override'], { HOME: '/home/u' });
      assert.isTrue(Option.getOrThrow(started).envOverride);
    }),
  );

  it.effect('the help names the installed command and the pnpm scripts', () =>
    Effect.gen(function* () {
      const text = yield* help;
      assert.include(text, 'llama-webui [options]');
      assert.include(text, 'pnpm start [options]');
      assert.include(text, 'app/.output/llama-webui.mjs');
      assert.include(text, 'pnpm dev ');
      assert.include(text, 'single Node.js process');
      // `pnpm dev` takes the environment and `.env`, not flags.
      assert.notInclude(text, 'pnpm dev [options]');
      assert.notMatch(text, /\bbun\b/i);
    }),
  );

  it.effect('the help names each option with its variable', () =>
    Effect.gen(function* () {
      const text = yield* help;
      for (const name of [
        '--host',
        '--port',
        '--data-dir',
        '--env-override',
        'env: LLAMA_WEBUI_HOST',
        'env: LLAMA_WEBUI_PORT',
        'env: LLAMA_WEBUI_DATA_DIR',
        'env: LLAMA_WEBUI_ENV_OVERRIDE',
      ])
        assert.include(text, name);
    }),
  );

  it.effect('the built-in flags are help and version only', () =>
    Effect.gen(function* () {
      for (const args of [['--wizard'], ['--completions', 'bash'], ['--log-level', 'debug']]) {
        const { exit, started } = yield* run(args, { HOME: '/home/u' });
        assert.isTrue(Exit.isFailure(exit), Arr.join(args, ' '));
        assert.isTrue(Option.isNone(started), Arr.join(args, ' '));
      }
      const { exit, started, out } = yield* run(['--version']);
      assert.isTrue(Exit.isSuccess(exit));
      assert.isTrue(Option.isNone(started));
      assert.include(out, 'llama-webui v');
    }),
  );
});
