import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { commitOf, removeWorktree, targetAt, worktreeAddArgs } from './target.ts';

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0).toReversed()) c();
});

/** A repository with one commit on `main`, and a folder next to it for a worktree. */
function tempRepo() {
  const root = mkdtempSync(join(tmpdir(), 'profiling-target-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, 'repo');
  mkdirSync(dir);
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'file.txt'), 'one\n');
  git('add', '.');
  git('-c', 'user.name=test', '-c', 'user.email=test@example.invalid', 'commit', '-q', '-m', 'one');
  return { dir, git, worktree: join(root, 'base') };
}

test('a target is a checkout and the build under its app folder', () => {
  expect(targetAt('/x')).toEqual({
    root: '/x',
    app: '/x/app',
    output: '/x/app/.output',
    launcher: '/x/app/.output/llama-webui.mjs',
    serverBundle: '/x/app/.output/server/index.mjs',
  });
});

test('a ref names its commit; an unknown one, an empty one or an option names none', () => {
  const { dir, git } = tempRepo();
  expect(commitOf('main', dir)).toBe(git('rev-parse', 'HEAD'));
  expect(commitOf('HEAD', dir)).toBe(git('rev-parse', 'HEAD'));
  expect(commitOf('no-such-branch', dir)).toBeNull();
  expect(commitOf('', dir)).toBeNull();
  expect(commitOf('--all', dir)).toBeNull();
});

test('a worktree is removed with what was built in it, and leaves no entry in its repository', () => {
  const { dir, git, worktree } = tempRepo();
  const commit = git('rev-parse', 'HEAD');
  execFileSync('git', worktreeAddArgs(worktree, commit, dir), { stdio: 'ignore' });
  // What an install and a build leave: untracked files, and a tracked one changed.
  mkdirSync(join(worktree, 'node_modules'));
  writeFileSync(join(worktree, 'node_modules', 'built.js'), '');
  writeFileSync(join(worktree, 'file.txt'), 'changed\n');
  removeWorktree(worktree);
  expect(existsSync(worktree)).toBe(false);
  expect(git('worktree', 'list').split('\n')).toHaveLength(1);
  expect(existsSync(join(dir, 'file.txt'))).toBe(true);
});

test('a folder that is not a worktree, or a repository itself, is never removed', () => {
  const { dir } = tempRepo();
  const inside = join(dir, 'sub');
  mkdirSync(inside);
  expect(() => removeWorktree(inside)).toThrow('is not a git worktree');
  expect(existsSync(inside)).toBe(true);
  // git refuses a main working tree, in the language of the machine: the command that failed is the stable part.
  expect(() => removeWorktree(dir)).toThrow('worktree remove --force');
  expect(existsSync(join(dir, 'file.txt'))).toBe(true);
});
