import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';

const pkg = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8'));

test('the root package is the one npm installs', () => {
  expect(pkg.bin).toEqual({ 'llama-webui': 'dist/server/main.js' });
  // Not all of dist/: an executable left there by an old `bun run compile` would ship too.
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
