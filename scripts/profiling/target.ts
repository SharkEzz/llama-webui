// The side a pass measures: a checkout and its production build. The working tree, or with `--base` a git worktree of
// the base ref under the base run's folder, installed there and removed by the run's undo.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const REPO = resolve(import.meta.dirname, '../..');

export interface Target {
  /** the checkout the build is made from */
  root: string;
  app: string;
  output: string;
  launcher: string;
  serverBundle: string;
}

export function targetAt(root: string): Target {
  const app = join(root, 'app');
  const output = join(app, '.output');
  return {
    root,
    app,
    output,
    launcher: join(output, 'llama-webui.mjs'),
    serverBundle: join(output, 'server/index.mjs'),
  };
}

/** The working tree: what `pnpm profiling` measures without `--base`, and the head with it. */
export const HEAD: Target = targetAt(REPO);

const git = (cwd: string, args: string[]): string =>
  execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** The commit a ref names in the repository at `repo`, null when it names none. */
export function commitOf(ref: string, repo = REPO): string | null {
  // A ref that starts with a dash would be read as an option.
  if (ref === '' || ref.startsWith('-')) return null;
  try {
    return git(repo, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  } catch {
    return null;
  }
}

/** The arguments that check `commit` out, detached, in a new worktree at `path`. */
export const worktreeAddArgs = (path: string, commit: string, repo = REPO): string[] => [
  '-C',
  repo,
  'worktree',
  'add',
  '--detach',
  path,
  commit,
];

/** The install of a worktree: the lockfile's versions, from the store, without the `prepare` script a build does not need. */
export const INSTALL_ARGS = ['install', '--frozen-lockfile', '--ignore-scripts', '--prefer-offline'];

/**
 * Removes a worktree with what was installed and built in it, and its entry in the repository it belongs to (read from
 * the worktree itself). A folder already gone only has its entry pruned; a folder that is not the root of a worktree
 * is refused, and git refuses a repository's main working tree.
 */
export function removeWorktree(path: string): void {
  if (!existsSync(path)) {
    git(REPO, ['worktree', 'prune']);
    return;
  }
  const top = git(path, ['rev-parse', '--show-toplevel']);
  if (resolve(top) !== resolve(path)) throw new Error(`${path} is not a git worktree`);
  const gitDir = git(path, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  execFileSync('git', ['--git-dir', gitDir, 'worktree', 'remove', '--force', path], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}
