// Dossiers : node:fs, comme le recommande Bun (Bun.file et Bun.write ne traitent que des fichiers).
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface TempDir extends Disposable {
  path: string;
}

/**
 * Dossier temporaire pour un test, supprimé à la sortie de sa portée (`using dir = tempDir('lw-')`), y compris quand le
 * test échoue. Au niveau d'un module (`using` y libérerait avant les tests) : `afterAll(() => dir[Symbol.dispose]())`.
 */
export function tempDir(prefix: string): TempDir {
  const path = mkdtempSync(join(tmpdir(), prefix));
  return { path, [Symbol.dispose]: () => rmSync(path, { recursive: true, force: true }) };
}
