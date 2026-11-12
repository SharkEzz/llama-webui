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
