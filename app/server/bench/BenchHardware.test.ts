import { NodeServices } from '@effect/platform-node';
import { assert, describe, it } from '@effect/vitest';
import { Array as Arr, Effect, FileSystem, Layer, Path, type Scope, String as Str } from 'effect';
import type { ChildProcessSpawner } from 'effect/process';
import * as Db from '../db/Db.ts';
import { CpuInfo } from '../hardware/CpuInfo.ts';
import { SettingsRepo } from '../settings/SettingsRepo.ts';
import { pidAlive } from '../testing/llama.ts';
import { BenchHardware } from './BenchHardware.ts';

/** The hardware on a new database and new caches, with the Node platform for the scripts the test writes. */
const Fresh = BenchHardware.layer.pipe(
  Layer.provideMerge(Layer.mergeAll(SettingsRepo.layer, CpuInfo.layer)),
  Layer.provideMerge(Db.layerAt(':memory:')),
  Layer.provideMerge(NodeServices.layer),
);

type Services =
  | BenchHardware
  | SettingsRepo
  | FileSystem.FileSystem
  | Path.Path
  | ChildProcessSpawner.ChildProcessSpawner
  | Scope.Scope;

/** `test` on its own caches, in a scope closed at its end. */
const fresh = <A, E>(test: Effect.Effect<A, E, Services>) =>
  Layer.build(Fresh).pipe(
    Effect.flatMap((context) => Effect.provideContext(test, context)),
    Effect.scoped,
  );

/** A folder of the test's own, and a way to write in it an executable shell script with a given mtime. */
const workspace = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = yield* fs.makeTempDirectoryScoped({ prefix: 'lw-bench-hw-' });
  /** The script `name` with `body` after its shebang, mode 755, modified at `version` × 1000 s. */
  const script = Effect.fn('script')(function* (name: string, body: string, version: number) {
    const file = path.join(dir, name);
    yield* fs.writeFileString(file, `#!/bin/sh\n${body}\n`);
    yield* fs.chmod(file, 0o755);
    yield* fs.utimes(file, version * 1000, version * 1000);
    return file;
  });
  return { dir, script };
});

const LIST = 'Available devices:\n  CUDA0: NVIDIA GeForce RTX 5070 Ti (15933 MiB, 15643 MiB free)\n';

describe('BenchHardware', () => {
  it.effect('buildOf reads the version again after the binary is rebuilt', () =>
    fresh(
      Effect.gen(function* () {
        const hw = yield* BenchHardware;
        const { script } = yield* workspace;
        const version = (n: number) =>
          script(
            'llama-server',
            `echo "version: ${n} (c${n})" >&2\necho "built with cc (build ${n}, commit c${n})" >&2`,
            n,
          );
        const bin = yield* version(1);
        const first = yield* hw.build(bin);
        assert.strictEqual(first, 'b1 (c1)');
        yield* version(2);
        const second = yield* hw.build(bin);
        assert.strictEqual(second, 'b2 (c2)');
      }),
    ),
  );

  it.effect('a crashed device listing is not cached, and the last good list is kept (#15)', () =>
    fresh(
      Effect.gen(function* () {
        const hw = yield* BenchHardware;
        const { script } = yield* workspace;
        const bin = yield* script('llama-bench', `printf '${LIST}'`, 1);
        const good = yield* hw.devices(bin);
        assert.deepStrictEqual(
          Arr.map(good.devices, (d) => d.id),
          ['CUDA0'],
        );
        // Rebuilt, then crashing halfway (as while llama-server runs): partial output, killed by a signal.
        yield* script(
          'llama-bench',
          `printf 'Available devices:\\n  CUDA0: NVIDIA GeForce RTX 5070 Ti (0 MiB, 0 MiB free)\\n'; kill -SEGV $$`,
          2,
        );
        const crashed = yield* hw.devices(bin);
        assert.deepStrictEqual(
          Arr.map(crashed.devices, (d) => [d.id, d.totalMib]),
          [['CUDA0', 15933]],
        );
        assert.include(crashed.error, 'SIGSEGV');
        // Not cached: once it works again, the new list is read.
        yield* script('llama-bench', `printf '${Str.replace('15933', '16000')(LIST)}'`, 2);
        const again = yield* hw.devices(bin);
        assert.strictEqual(again.devices[0]?.totalMib, 16000);
      }),
    ),
  );

  it.effect('a crash with no earlier list gives no devices and says why (#15)', () =>
    fresh(
      Effect.gen(function* () {
        const hw = yield* BenchHardware;
        const { script } = yield* workspace;
        const bin = yield* script(
          'llama-bench',
          `printf '  CUDA0: NVIDIA GeForce RTX 5070 Ti (0 MiB, 0 MiB free)\\n'; exit 134`,
          1,
        );
        const listed = yield* hw.devices(bin);
        assert.deepStrictEqual(listed.devices, []);
        assert.include(listed.error, 'code 134');
        const devices = yield* hw.listDevices(bin);
        assert.deepStrictEqual(devices, []);
      }),
    ),
  );

  it.effect('a GPU listed with 0 MiB is not cached (#15)', () =>
    fresh(
      Effect.gen(function* () {
        const hw = yield* BenchHardware;
        const { script } = yield* workspace;
        const bin = yield* script(
          'llama-bench',
          `printf '  CUDA0: NVIDIA GeForce RTX 5070 Ti (0 MiB, 0 MiB free)\\n  BLAS: OpenBLAS (0 MiB, 0 MiB free)\\n'`,
          1,
        );
        const empty = yield* hw.devices(bin);
        assert.include(empty.error, 'CUDA0');
        yield* script('llama-bench', `printf '${LIST}'`, 1);
        const good = yield* hw.devices(bin);
        assert.strictEqual(good.devices[0]?.totalMib, 15933);
      }),
    ),
  );

  it.effect('a listing that prints more than 1 MiB fails at once and its program is killed', () =>
    fresh(
      Effect.gen(function* () {
        const hw = yield* BenchHardware;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { dir, script } = yield* workspace;
        const pidFile = path.join(dir, 'pid');
        const bin = yield* script('llama-bench', `echo $$ > '${pidFile}'\nexec yes`, 1);
        const listed = yield* hw.devices(bin);
        assert.deepStrictEqual(listed.devices, []);
        assert.include(listed.error, 'printed more than 1 MiB');
        const written = yield* fs.readFileString(pidFile);
        const pid = Number(Str.trim(written));
        assert.isFalse(pidAlive(pid));
      }),
    ),
  );

  it.effect("the listing of a binary that is not there is no devices with the spawn's message", () =>
    fresh(
      Effect.gen(function* () {
        const hw = yield* BenchHardware;
        const { dir } = yield* workspace;
        const path = yield* Path.Path;
        const missing = path.join(dir, 'llama-bench');
        const listed = yield* hw.devices(missing);
        assert.deepStrictEqual(listed.devices, []);
        assert.include(listed.error, 'ENOENT');
        assert.include(listed.error, missing);
      }),
    ),
  );

  it.effect('the hardware freezes the CPU, the GPUs and the build of the binary setting', () =>
    fresh(
      Effect.gen(function* () {
        const hw = yield* BenchHardware;
        const settings = yield* SettingsRepo;
        const { script } = yield* workspace;
        const bin = yield* script('llama-server', 'echo "built with cc (build 7, commit abc)"', 1);
        yield* settings.patch({ binary: bin });
        const frozen = yield* hw.hardware([{ name: 'GPU', busId: '0000:01:00.0', vramTotalBytes: 1024 }]);
        assert.deepStrictEqual(frozen.gpus, [{ name: 'GPU', busId: '0000:01:00.0', vramTotalBytes: 1024 }]);
        assert.strictEqual(frozen.build, 'b7 (abc)');
        assert.isString(frozen.cpu);
      }),
    ),
  );
});
