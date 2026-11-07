import { expect, test } from 'bun:test';
import { chmodSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from '../testing/tempDir';
import { buildOf } from './hardware';

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
