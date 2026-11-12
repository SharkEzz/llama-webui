import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/** Writes a file, creating its parent directories first (fake `/proc` and `/sys` trees, model files…). */
export async function writeFileDeep(path: string, data: string | Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, data);
}
