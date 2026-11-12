import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, test } from 'vitest';

const pkg = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8'));

test('the root package is the one npm installs', () => {
  expect(pkg.bin).toEqual({ 'llama-webui': 'dist/server/main.js' });
  // Not all of dist/: an old executable (the Bun builds’ `dist/llama-webui`) would ship too.
  expect(pkg.files).toEqual(['dist/server', 'dist/web']);
  expect(pkg.os).toEqual(['linux']);
  expect(pkg.engines.node).toMatch(/^>=26\./);
  // What main.js and nvml-worker.js import besides Node: everything else is bundled.
  expect(pkg.dependencies).toEqual({ '@hono/node-server': 'catalog:', hono: 'catalog:', ws: 'catalog:' });
});

test('the runtime dependencies are pinned to exact versions', () => {
  // `pnpm pack` writes the catalog's specifier into the published package.json, and npm resolves it at install time,
  // with no lockfile: a range would let a newer release, never tested, into an install. The three have no
  // dependencies of their own, so exact versions pin the whole runtime tree (the tarball smoke checks it).
  const workspace = readFileSync(join(import.meta.dirname, '..', 'pnpm-workspace.yaml'), 'utf8');
  for (const name of Object.keys(pkg.dependencies)) {
    const line = workspace.split('\n').find((l) => l.replace(/"/g, '').startsWith(`  ${name}:`));
    expect(line, name).toMatch(/:\s+\d+\.\d+\.\d+$/);
  }
});

test('packing without a build fails instead of shipping a package with no command', () => {
  // npm runs `prepack` before `pnpm pack` (and `npm pack`) writes the tarball, from the package's root.
  expect(pkg.scripts.prepack).toBe('node scripts/prepack.ts');
  const script = join(import.meta.dirname, 'prepack.ts');
  const empty = mkdtempSync(join(tmpdir(), 'lw-prepack-'));
  try {
    const refused = spawnSync(process.execPath, [script], { cwd: empty, encoding: 'utf8' });
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain('pnpm build');
    for (const file of ['dist/server/main.js', 'dist/server/nvml-worker.js', 'dist/web/index.html']) {
      mkdirSync(dirname(join(empty, file)), { recursive: true });
      writeFileSync(join(empty, file), '');
    }
    expect(spawnSync(process.execPath, [script], { cwd: empty }).status).toBe(0);
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});
