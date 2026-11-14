import { NodeServices } from '@effect/platform-node';
import { assert, layer } from '@effect/vitest';
import { Array as Arr, Effect, FileSystem, Path } from 'effect';
import { readCpuInfo } from './cpu.ts';

/** Two sockets of two cores, two threads each; the core ids repeat from one socket to the other. */
const TWO_SOCKETS = Arr.join(
  Arr.makeBy(8, (i) =>
    Arr.join(
      [
        `processor\t: ${i}`,
        'model name\t: Fake CPU 9000',
        `physical id\t: ${Math.floor(i / 4)}`,
        `core id\t: ${Math.floor(i / 2) % 2}`,
        'flags\t\t: fpu sse2 avx2',
      ],
      '\n',
    ),
  ),
  '\n\n',
);

layer(NodeServices.layer)('cpu', (it) => {
  it.effect('readCpuInfo counts distinct physical cores, threads and NUMA nodes', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: 'lw-cpu-' });
      const procRoot = path.join(root, 'proc');
      const sysRoot = path.join(root, 'sys');
      yield* fs.makeDirectory(procRoot, { recursive: true });
      yield* fs.writeFileString(path.join(procRoot, 'cpuinfo'), TWO_SOCKETS);
      for (const entry of ['node0', 'node1', 'nodeX', 'possible']) {
        yield* fs.makeDirectory(path.join(sysRoot, 'devices', 'system', 'node', entry), { recursive: true });
      }
      const cpu = yield* readCpuInfo({ procRoot, sysRoot });
      assert.deepStrictEqual(cpu, {
        model: 'Fake CPU 9000',
        physicalCores: 4,
        logicalThreads: 8,
        flags: ['fpu', 'sse2', 'avx2'],
        numaNodes: 2,
      });
    }).pipe(Effect.scoped),
  );

  it.effect('readCpuInfo without sysfs counts one NUMA node', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: 'lw-cpu-' });
      yield* fs.writeFileString(path.join(root, 'cpuinfo'), TWO_SOCKETS);
      const cpu = yield* readCpuInfo({ procRoot: root, sysRoot: path.join(root, 'no-sys') });
      assert.strictEqual(cpu.numaNodes, 1);
      assert.strictEqual(cpu.logicalThreads, 8);
      // Nothing readable at all: at least one core and one thread.
      const none = yield* readCpuInfo({ procRoot: path.join(root, 'nothing'), sysRoot: path.join(root, 'no-sys') });
      assert.deepStrictEqual(none, { model: '', physicalCores: 1, logicalThreads: 1, flags: [], numaNodes: 1 });
    }).pipe(Effect.scoped),
  );
});
