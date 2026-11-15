import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, test } from 'vitest';

const pkg = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8'));

test('the root package is the one npm installs', () => {
  expect(pkg.bin).toEqual({ 'llama-webui': 'app/.output/llama-webui.mjs' });
  // Nitro's whole output: the launcher, the server and its chunks, the NVML sampler, the client assets.
  expect(pkg.files).toEqual(['app/.output']);
  expect(pkg.os).toEqual(['linux']);
  expect(pkg.engines.node).toMatch(/^>=26\./);
});

test('the package has no runtime dependency: the build is self-contained', () => {
  // Nitro bundles everything the server imports: an install from the tarball has nothing to resolve (no lockfile).
  expect(pkg.dependencies ?? {}).toEqual({});
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
    for (const file of ['app/.output/llama-webui.mjs', 'app/.output/server/index.mjs']) {
      mkdirSync(dirname(join(empty, file)), { recursive: true });
      writeFileSync(join(empty, file), '');
    }
    expect(spawnSync(process.execPath, [script], { cwd: empty }).status).toBe(0);
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});
