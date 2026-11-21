import { renameSync, writeFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/** Writes a file, creating its parent directories first (fake `/proc` and `/sys` trees, model files…). */
export async function writeFileDeep(path: string, data: string | Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, data);
}

/** Replaces a file in one step (write then rename), as an editor's safe write or `git checkout` does. */
export function writeFileAtomic(path: string, text: string): void {
  writeFileSync(`${path}.tmp`, text);
  renameSync(`${path}.tmp`, path);
}
