import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { afterEach, expect, test } from 'vitest';
import { ENCODED_TYPES } from '../server/http/Static.ts';
import { COMPRESSIBLE, MIN_SIZE, precompress } from './precompress.ts';

let dir = '';
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Text that compresses well, `size` bytes long. */
const text = (size: number) => 'export const a = 1;\n'.repeat(Math.ceil(size / 20)).slice(0, size);

test('a text asset over 1 KiB gets a .br and a .gz that decode to it (#105)', async () => {
  dir = mkdtempSync(join(tmpdir(), 'lw-precompress-'));
  const js = text(8 * 1024);
  writeFileSync(join(dir, 'a-1.js'), js);
  writeFileSync(join(dir, 'b-2.css'), text(4 * 1024));
  const result = await precompress(dir);
  expect(result.files).toBe(2);
  expect(result.written.map((f) => f.slice(dir.length + 1))).toEqual([
    'a-1.js.br',
    'a-1.js.gz',
    'b-2.css.br',
    'b-2.css.gz',
  ]);
  expect(brotliDecompressSync(readFileSync(join(dir, 'a-1.js.br'))).toString()).toBe(js);
  expect(gunzipSync(readFileSync(join(dir, 'a-1.js.gz'))).toString()).toBe(js);
  expect(result.bytes).toBe(12 * 1024);
  expect(result.br).toBeLessThan(result.gz);
  expect(result.gz).toBeLessThan(result.bytes);
});

test('a small file, a type compressed already and a subfolder are left as they are (#105)', async () => {
  dir = mkdtempSync(join(tmpdir(), 'lw-precompress-'));
  writeFileSync(join(dir, 'small.js'), text(MIN_SIZE));
  writeFileSync(join(dir, 'font.woff2'), text(8 * 1024));
  writeFileSync(join(dir, 'map.js.map'), text(8 * 1024));
  mkdirSync(join(dir, 'sub'));
  writeFileSync(join(dir, 'sub', 'c-3.js'), text(8 * 1024));
  const result = await precompress(dir);
  expect(result).toEqual({ files: 0, written: [], bytes: 0, br: 0, gz: 0 });
  expect(new Set(readdirSync(dir, { recursive: true, encoding: 'utf8' }))).toEqual(
    new Set(['font.woff2', 'map.js.map', 'small.js', 'sub', 'sub/c-3.js']),
  );
});

test('a variant that is not smaller than its file is not written (#105)', async () => {
  dir = mkdtempSync(join(tmpdir(), 'lw-precompress-'));
  // Random bytes do not compress: each variant would be larger.
  const noise = randomBytes(4096);
  writeFileSync(join(dir, 'noise.wasm'), noise);
  const result = await precompress(dir);
  expect(result.written).toEqual([]);
  expect(result).toMatchObject({ files: 1, bytes: 4096, br: 4096, gz: 4096 });
});

test('the server knows the type of every extension the build compresses, and no other (#105)', () => {
  expect(new Set([...COMPRESSIBLE].map((ext) => ext.slice(1)))).toEqual(new Set(Object.keys(ENCODED_TYPES)));
});
