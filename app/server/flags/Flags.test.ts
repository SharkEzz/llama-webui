import { NodeServices } from '@effect/platform-node';
import { assert, describe, it } from '@effect/vitest';
import {
  Array as Arr,
  ConfigProvider,
  Duration,
  Effect,
  FileSystem,
  Layer,
  Path,
  type Scope,
  String as Str,
} from 'effect';
import { ChildProcess, ChildProcessSpawner } from 'effect/process';
import * as Db from '../db/Db.ts';
import { SettingsRepo } from '../settings/SettingsRepo.ts';
import { Flags } from './Flags.ts';

/** The catalogue on a new database and a new cache, with the Node platform for the scripts the test writes. */
const Fresh = Flags.layer.pipe(
  Layer.provideMerge(SettingsRepo.layer),
  Layer.provideMerge(Db.layerAt(':memory:')),
  Layer.provideMerge(NodeServices.layer),
);

type Services =
  | Flags
  | SettingsRepo
  | FileSystem.FileSystem
  | Path.Path
  | ChildProcessSpawner.ChildProcessSpawner
  | Scope.Scope;

/** `test` on its own database and cache, in a scope closed at its end (its folder removed). */
const fresh = <A, E>(test: Effect.Effect<A, E, Services>) =>
  Layer.build(Fresh).pipe(
    Effect.flatMap((context) => Effect.provideContext(test, context)),
    Effect.scoped,
  );

/** A folder of the test's own, and a way to write an executable shell script in it. */
const workspace = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = yield* fs.makeTempDirectoryScoped({ prefix: 'lw-flags-' });
  const fake = path.resolve(import.meta.dirname, '../../../testdata/fake/fake-llama-server');
  /** The script `name` with `body` after its shebang, mode 755; `$DIR` is the folder, `$FAKE` the fake server. */
  const script = Effect.fn('script')(function* (name: string, body: string) {
    const file = path.join(dir, name);
    yield* fs.writeFileString(file, `#!/bin/sh\nDIR='${dir}'\nFAKE='${fake}'\n${body}\n`);
    yield* fs.chmod(file, 0o755);
    return file;
  });
  /** How many times the script that counts in `name` ran. */
  const runs = Effect.fn('runs')(function* (name: string) {
    const file = path.join(dir, name);
    const exists = yield* fs.exists(file);
    if (!exists) return 0;
    const text = yield* fs.readFileString(file);
    return Str.split(Str.trim(text), '\n').length;
  });
  return { dir, fake, script, runs };
});

/** The catalogue with `binary` as the setting. */
const catalogOf = (binary: string) =>
  Effect.gen(function* () {
    const settings = yield* SettingsRepo;
    yield* settings.patch({ binary });
    const flags = yield* Flags;
    return yield* flags.catalog;
  });

/** A script that counts its runs in `count`, then answers as the fake llama-server. */
const counting = (count: string, before = '') => `${before}\necho run >> "$DIR/${count}"\nexec "$FAKE" "$@"`;

describe('Flags', () => {
  it.live('the catalogue is the parsed --help, read once per binary', () =>
    fresh(
      Effect.gen(function* () {
        const { fake, script, runs } = yield* workspace;
        const catalog = yield* catalogOf(fake);
        assert.isAbove(catalog.flags.length, 0);
        assert.isDefined(catalog.byName.get('--ctx-size') ?? catalog.flags[0]);
        const binary = yield* script('once', counting('once.count'));
        for (let i = 0; i < 3; i++) yield* catalogOf(binary);
        const count = yield* runs('once.count');
        assert.strictEqual(count, 1);
      }),
    ),
  );

  it.live('callers at the same time share one run', () =>
    fresh(
      Effect.gen(function* () {
        const { script, runs } = yield* workspace;
        const binary = yield* script('slow', counting('slow.count', 'sleep 0.2'));
        const settings = yield* SettingsRepo;
        yield* settings.patch({ binary });
        const flags = yield* Flags;
        const all = yield* Effect.all(
          Array.from({ length: 5 }, () => flags.catalog),
          { concurrency: 'unbounded' },
        );
        assert.strictEqual(all.length, 5);
        const count = yield* runs('slow.count');
        assert.strictEqual(count, 1);
      }),
    ),
  );

  it.live('a changed binary setting reads the new binary', () =>
    fresh(
      Effect.gen(function* () {
        const { script, runs } = yield* workspace;
        const a = yield* script('a', counting('a.count'));
        const b = yield* script('b', counting('b.count'));
        yield* catalogOf(a);
        yield* catalogOf(b);
        yield* catalogOf(a);
        const counts = yield* Effect.all([runs('a.count'), runs('b.count')]);
        assert.deepStrictEqual(counts, [1, 1]);
      }),
    ),
  );

  it.live('a failure is FlagsUnavailable naming the binary, and is tried again', () =>
    fresh(
      Effect.gen(function* () {
        const { dir, script, runs } = yield* workspace;
        const missing = `${dir}/no-such-llama-server`;
        const exits = yield* script('exits', 'exit 3');
        const silent = yield* script('silent', 'echo "no flag here"');
        // A valid flag line, again and again, past 16 MiB.
        const loud = yield* script('loud', `yes -- '${Str.padEnd(40)('--loud N')}help' | head -c 17000000`);
        for (const binary of [missing, exits, silent, loud]) {
          const failure = yield* Effect.flip(catalogOf(binary));
          assert.strictEqual(failure._tag, 'FlagsUnavailable', binary);
          assert.strictEqual(failure.message, `llama-server --help failed (${binary})`);
        }
        // Fails on its first run, answers on the next ones.
        const flaky = yield* script(
          'flaky',
          counting('flaky.count', '[ -f "$DIR/flaky.count" ] || { echo run >> "$DIR/flaky.count"; exit 1; }'),
        );
        const first = yield* Effect.flip(catalogOf(flaky));
        assert.strictEqual(first._tag, 'FlagsUnavailable');
        const second = yield* catalogOf(flaky);
        assert.isAbove(second.flags.length, 0);
        const count = yield* runs('flaky.count');
        assert.strictEqual(count, 2);
      }),
    ),
  );

  it.live(
    'a --help that never ends fails after 5 s and its process is gone',
    () =>
      fresh(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
          const { dir, script } = yield* workspace;
          // The script and the `sleep` it waits for each write their pid.
          const binary = yield* script('hangs', 'echo $$ > "$DIR/pid"\nsleep 60 &\necho $! >> "$DIR/pid"\nwait');
          const [elapsed, error] = yield* Effect.flip(catalogOf(binary)).pipe(Effect.timed);
          assert.strictEqual(error._tag, 'FlagsUnavailable');
          assert.isAtLeast(Duration.toMillis(elapsed), 4900);
          const text = yield* fs.readFileString(`${dir}/pid`);
          const pids = Str.split(Str.trim(text), '\n');
          assert.strictEqual(pids.length, 2);
          // Both are gone: `kill -0` finds neither.
          const codes = yield* Effect.forEach(pids, (pid) =>
            spawner.exitCode(ChildProcess.make('sh', ['-c', `kill -0 ${pid} 2>/dev/null`])),
          );
          assert.isTrue(Arr.every(codes, (code) => code !== 0));
        }),
      ),
    15_000,
  );

  it.live('~ in the binary setting is the home directory', () =>
    fresh(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { dir, script } = yield* workspace;
        yield* fs.makeDirectory(`${dir}/bin`);
        yield* script('bin/llama-server', 'exec "$FAKE" "$@"');
        const catalog = yield* catalogOf('~/bin/llama-server').pipe(
          Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnv({ env: { HOME: dir } })),
        );
        assert.isAbove(catalog.flags.length, 0);
        const failure = yield* Effect.flip(
          catalogOf('~/bin/nope').pipe(
            Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnv({ env: { HOME: dir } })),
          ),
        );
        assert.strictEqual(failure.message, `llama-server --help failed (${dir}/bin/nope)`);
      }),
    ),
  );
});
