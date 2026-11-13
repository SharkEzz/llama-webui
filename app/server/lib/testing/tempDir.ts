import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface TempDir extends Disposable {
  path: string;
}

/**
 * Temporary directory for a test, deleted when it goes out of scope (`using dir = tempDir('lw-')`), even when the
 * test fails. At module level (`using` would release it before the tests): `afterAll(() => dir[Symbol.dispose]())`.
 */
export function tempDir(prefix: string): TempDir {
  const path = mkdtempSync(join(tmpdir(), prefix));
  return { path, [Symbol.dispose]: () => rmSync(path, { recursive: true, force: true }) };
}
