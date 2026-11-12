import { expect, test } from 'vitest';
import { tempDir } from '../testing/tempDir';
import { writeFileDeep } from '../testing/write';
import { measureDiskSpeed } from './disk';

test('measureDiskSpeed: a missing path or a directory is a 404, a small file a 400', async () => {
  using dir = tempDir('lw-disk-');
  await expect(measureDiskSpeed(`${dir.path}/missing.gguf`)).rejects.toMatchObject({ status: 404 });
  await expect(measureDiskSpeed(dir.path)).rejects.toMatchObject({ status: 404 });
  await writeFileDeep(`${dir.path}/small.gguf`, 'x'.repeat(1024));
  await expect(measureDiskSpeed(`${dir.path}/small.gguf`)).rejects.toMatchObject({
    status: 400,
    message: 'File too small to measure (0 MiB)',
  });
});

test('measureDiskSpeed: reads the requested bytes and times them', async () => {
  using dir = tempDir('lw-disk-');
  const path = `${dir.path}/model.gguf`;
  await writeFileDeep(path, Buffer.alloc(65 * 1024 ** 2));
  const ticks = [0, 500];
  const speed = await measureDiskSpeed(path, { offsetFraction: 0, now: () => ticks.shift() ?? 500 });
  expect([speed.sampledBytes, speed.bytesPerSec, speed.path]).toEqual([65 * 1024 ** 2, 130 * 1024 ** 2, path]);
});
