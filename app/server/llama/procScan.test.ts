import { NodeServices } from '@effect/platform-node';
import { assert, layer } from '@effect/vitest';
import { Array as Arr, Effect, FileSystem, Option, Path, Record } from 'effect';
import { findLlamaServerPid, isAlive } from './procScan.ts';

/** A folder made like `/proc`: one `<pid>/cmdline` per entry, its arguments separated by NUL. */
const procOf = (processes: Readonly<Record<string, ReadonlyArray<string> | 'unreadable'>>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: 'lw-proc-' });
    for (const [pid, argv] of Record.toEntries(processes)) {
      const dir = path.join(root, pid);
      yield* fs.makeDirectory(dir);
      // A folder where the file should be: reading it fails.
      if (argv === 'unreadable') yield* fs.makeDirectory(path.join(dir, 'cmdline'));
      else yield* fs.writeFileString(path.join(dir, 'cmdline'), `${Arr.join(argv, '\0')}\0`);
    }
    return root;
  });

layer(NodeServices.layer, { excludeTestServices: true })('procScan', (it) => {
  it.effect(
    'the pid of the llama-server on the port; 8080 when it names no port; another program on the port is not one',
    () =>
      Effect.gen(function* () {
        const root = yield* procOf({
          '12': ['/usr/bin/python3', '-m', 'http.server', '--port', '9001'],
          '34': ['/opt/llama/llama-server', '-m', '/m.gguf', '--port', '9001'],
          '56': ['llama-server', '-m', '/m.gguf'],
          self: ['llama-server', '--port', '9002'],
        });
        const pids = yield* Effect.forEach([9001, 8080, 9002], (port) => findLlamaServerPid({ port, root }));
        assert.deepStrictEqual(pids, [Option.some(34), Option.some(56), Option.none()]);
      }),
  );

  it.effect('an entry that cannot be read is skipped, a root that does not exist is none', () =>
    Effect.gen(function* () {
      const root = yield* procOf({ '1': 'unreadable', '2': ['llama-server', '--port=9003'] });
      const pids = yield* Effect.forEach([root, `${root}/nothing`], (at) =>
        findLlamaServerPid({ port: 9003, root: at }),
      );
      assert.deepStrictEqual(pids, [Option.some(2), Option.none()]);
    }),
  );

  it.effect('isAlive: this process is, a pid that never ran is not', () =>
    Effect.gen(function* () {
      // Above the kernel's pid_max (2^22 at most): no process ever has it.
      const alive = yield* Effect.forEach([process.pid, 2 ** 22 + 1], isAlive);
      assert.deepStrictEqual(alive, [true, false]);
    }),
  );
});
