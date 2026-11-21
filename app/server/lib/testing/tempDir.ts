import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface TempDir extends Disposable {
  path: string;
}

/**
 * Temporary directory for a test, deleted when it goes out of scope (`using dir = tempDir('lw-')`), even when the
 * test fails. At module level (`using` would release it before the tests): `afterAll(() => dir[Symbol.dispose]())`.
 * Under the system's temporary directory, or under `parent` (created if need be).
 */
export function tempDir(prefix: string, parent = tmpdir()): TempDir {
  mkdirSync(parent, { recursive: true });
  const path = mkdtempSync(join(parent, prefix));
  return { path, [Symbol.dispose]: () => rmSync(path, { recursive: true, force: true }) };
}
