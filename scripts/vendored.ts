/**
 * Run by `prepare` (each `pnpm install`): keeps out of a vendored repository's checkout the files that break this
 * repository's tools. A sparse checkout of the submodule leaves them out of the working tree without deleting them,
 * so `git status` stays clean and an update of the submodule keeps them out. A submodule that is not initialised is
 * skipped: after `git submodule update --init`, run `pnpm install` again.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

// `repos/effect/.oxlintrc.json` names a JS plugin that is not installed here; oxlint's VS Code extension loads it
// (it does not read `.eslintignore`) and its language server stops.
export const EXCLUDED: Record<string, readonly string[]> = { 'repos/effect': ['.oxlintrc.json'] };

/** Checks out everything in `dir` but `files` (paths from its root); false when `dir` is not a git checkout or git fails. */
export function excludeFromCheckout(dir: string, files: readonly string[]): boolean {
  if (!existsSync(join(dir, '.git'))) return false;
  const patterns = ['/*', ...files.map((file) => `!/${file}`)];
  try {
    execFileSync('git', ['-C', dir, 'sparse-checkout', 'set', '--no-cone', ...patterns], { stdio: 'inherit' });
    return true;
  } catch (e) {
    // An old git or a refused safe.directory: the install goes on, the editor may still load the files
    console.warn(
      `vendored: could not leave ${files.join(', ')} out of ${dir}: ${e instanceof Error ? e.message : String(e)}`,
    );
    return false;
  }
}

if (import.meta.main) {
  const root = resolve(import.meta.dirname, '..');
  for (const [dir, files] of Object.entries(EXCLUDED)) excludeFromCheckout(join(root, dir), files);
}
