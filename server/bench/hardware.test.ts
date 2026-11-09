import { expect, test } from 'bun:test';
import { chmodSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from '../testing/tempDir';
import { buildOf, listDevices, listDevicesResult } from './hardware';

test('buildOf reads the version again after the binary is rebuilt', async () => {
  using dir = tempDir('lw-build-');
  const bin = join(dir.path, 'llama-server');
  const write = async (n: number) => {
    await Bun.write(
      bin,
      `#!/bin/sh\necho "version: ${n} (c${n})" >&2\necho "built with cc (build ${n}, commit c${n})" >&2\n`,
    );
    // Permissions and modification time: node:fs (Bun.write's `mode` option is ignored, Bun 1.4.4).
    chmodSync(bin, 0o755);
    utimesSync(bin, n * 1000, n * 1000);
  };
  await write(1);
  expect(await buildOf(bin)).toBe('b1 (c1)');
  await write(2);
  expect(await buildOf(bin)).toBe('b2 (c2)');
});

const LIST = 'Available devices:\n  CUDA0: NVIDIA GeForce RTX 5070 Ti (15933 MiB, 15643 MiB free)\n';

/** A fake llama-bench whose `--list-devices` prints `body` (shell), with a distinct mtime per version. */
async function fakeBench(path: string, body: string, version: number) {
  await Bun.write(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  utimesSync(path, version * 1000, version * 1000);
}

test('a crashed device listing is not cached, and the last good list is kept (#15)', async () => {
  using dir = tempDir('lw-devices-');
  const bin = join(dir.path, 'llama-bench');
  await fakeBench(bin, `printf '${LIST}'`, 1);
  expect((await listDevicesResult(bin)).devices.map((d) => d.id)).toEqual(['CUDA0']);
  // Rebuilt, then crashing halfway (as while llama-server runs): partial output, killed by a signal.
  await fakeBench(
    bin,
    `printf 'Available devices:\\n  CUDA0: NVIDIA GeForce RTX 5070 Ti (0 MiB, 0 MiB free)\\n'; kill -SEGV $$`,
    2,
  );
  const crashed = await listDevicesResult(bin);
  expect(crashed.devices.map((d) => [d.id, d.totalMib])).toEqual([['CUDA0', 15933]]);
  expect(crashed.error).toContain('SIGSEGV');
  // Not cached: once it works again, the new list is read.
  await fakeBench(bin, `printf '${LIST.replace('15933', '16000')}'`, 2);
  expect((await listDevicesResult(bin)).devices[0]?.totalMib).toBe(16000);
});

test('a crash with no earlier list gives no devices and says why (#15)', async () => {
  using dir = tempDir('lw-devices-');
  const bin = join(dir.path, 'llama-bench');
  await fakeBench(bin, `printf '  CUDA0: NVIDIA GeForce RTX 5070 Ti (0 MiB, 0 MiB free)\\n'; exit 134`, 1);
  const r = await listDevicesResult(bin);
  expect(r.devices).toEqual([]);
  expect(r.error).toContain('code 134');
  expect(await listDevices(bin)).toEqual([]);
});

test('a GPU listed with 0 MiB is not cached (#15)', async () => {
  using dir = tempDir('lw-devices-');
  const bin = join(dir.path, 'llama-bench');
  await fakeBench(
    bin,
    `printf '  CUDA0: NVIDIA GeForce RTX 5070 Ti (0 MiB, 0 MiB free)\\n  BLAS: OpenBLAS (0 MiB, 0 MiB free)\\n'`,
    1,
  );
  expect((await listDevicesResult(bin)).error).toContain('CUDA0');
  await fakeBench(bin, `printf '${LIST}'`, 1);
  expect((await listDevicesResult(bin)).devices[0]?.totalMib).toBe(15933);
});
