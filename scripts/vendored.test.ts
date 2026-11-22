import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { excludeFromCheckout } from './vendored';

const git = (dir: string, ...args: string[]) =>
  execFileSync('git', ['-C', dir, '-c', 'user.name=test', '-c', 'user.email=test@example.com', ...args], {
    encoding: 'utf8',
  });

test('an excluded file leaves the checkout and the tree stays clean', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lw-vendored-'));
  try {
    git(dir, 'init', '-q');
    writeFileSync(join(dir, '.oxlintrc.json'), '{}');
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src', 'index.ts'), 'export {};');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'init');

    expect(excludeFromCheckout(dir, ['.oxlintrc.json'])).toBe(true);
    expect(existsSync(join(dir, '.oxlintrc.json'))).toBe(false);
    expect(existsSync(join(dir, 'src', 'index.ts'))).toBe(true);
    expect(git(dir, 'status', '--porcelain')).toBe('');
    // A second run (the next install) changes nothing
    expect(excludeFromCheckout(dir, ['.oxlintrc.json'])).toBe(true);
    expect(existsSync(join(dir, '.oxlintrc.json'))).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a directory that is not a checkout is skipped', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lw-vendored-'));
  try {
    expect(excludeFromCheckout(dir, ['.oxlintrc.json'])).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
