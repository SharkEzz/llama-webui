// The production build (`app/.output`, built once by the server project's globalSetup): what `pnpm build` wrote.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { Array as Arr, Option, pipe, String as Str } from 'effect';
import { afterAll, expect, test, vi } from 'vitest';
import { launch } from './testing/launch.ts';
import { tempDir } from './testing/tempDir.ts';

const OUTPUT = resolve(import.meta.dirname, '../.output');
const assets = join(OUTPUT, 'public/assets');

/** What a built module imports: `import`/`export … from`, bare `import '…'`, `import('…')` and `require('…')`. */
const specifiers = (code: string) =>
  Arr.map(
    [
      ...Str.matchAll(/^\s*(?:import|export)\b[^'"`;]*?\bfrom\s*["']([^"']+)["']/gm)(code),
      ...Str.matchAll(/^\s*import\s*["']([^"']+)["']/gm)(code),
      ...Str.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g)(code),
      ...Str.matchAll(/\brequire\(\s*["']([^"']+)["']\s*\)/g)(code),
    ],
    (m) => m[1] as string,
  );

const dir = tempDir('lw-build-');
afterAll(() => dir[Symbol.dispose]());

test('the launcher starts from an empty folder outside the repository', async () => {
  const app = join(dir.path, 'app');
  const data = join(dir.path, 'data');
  cpSync(OUTPUT, app, { recursive: true });
  mkdirSync(data);
  await using server = await launch({ dataDir: data, launcher: join(app, 'llama-webui.mjs') });
  const res = await fetch(`${server.base}/api/health`);
  expect(res.status).toBe(200);
  const health = (await res.json()) as { version: string };
  expect(health.version).not.toBe('dev');
  await vi.waitFor(() => expect(server.stdout()).toContain('ready ('));
});

test('the server requires nothing but Node builtins', () => {
  const files = [
    'llama-webui.mjs',
    ...pipe(
      readdirSync(join(OUTPUT, 'server')),
      Arr.filter(Str.endsWith('.mjs')),
      Arr.map((f) => `server/${f}`),
    ),
  ];
  expect(files).toContain('server/index.mjs');
  const external = Arr.flatMap(files, (f) =>
    pipe(
      specifiers(readFileSync(join(OUTPUT, f), 'utf8')),
      // Node's built-in modules, with or without `node:`, and the files shipped beside the module.
      Arr.filter(
        (spec) => !isBuiltin(spec) && !(/^\.{1,2}\//.test(spec) && existsSync(join(OUTPUT, dirname(f), spec))),
      ),
      Arr.map((spec) => `${f}: ${spec}`),
    ),
  );
  expect(external).toEqual([]);
  expect(Str.startsWith('#!/usr/bin/env node')(readFileSync(join(OUTPUT, 'llama-webui.mjs'), 'utf8'))).toBe(true);
});

test('the client imports no node:* module', () => {
  const chunks = Arr.filter(readdirSync(assets), Str.endsWith('.js'));
  expect(chunks.length).toBeGreaterThan(0);
  // The browser has no `node:*` module: one in the bundle means server code leaked into the client.
  const leaks = Arr.filter(chunks, (c) =>
    Arr.some(specifiers(readFileSync(join(assets, c), 'utf8')), Str.startsWith('node:')),
  );
  expect(leaks).toEqual([]);
});

test('each page is a chunk of its own', () => {
  const html = readFileSync(join(OUTPUT, 'public/index.html'), 'utf8');
  const entry = pipe(
    Str.match(/<script type="module"[^>]*src="\/assets\/([^"]+\.js)"/)(html),
    Option.flatMap((m) => Option.fromUndefinedOr(m[1])),
  );
  expect(Option.isSome(entry)).toBe(true);
  const code = readFileSync(join(assets, Option.getOrThrow(entry)), 'utf8');
  expect(code).not.toContain('Not ported yet');
  expect(code).not.toContain('of the Effect server rewrite');
});

test('a deep URL gets the shell', async () => {
  const data = join(dir.path, 'deep');
  mkdirSync(data);
  await using server = await launch({ dataDir: data });
  const res = await fetch(`${server.base}/settings`);
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toContain('text/html');
  const html = await res.text();
  const refs = Arr.map([...Str.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)(html)], (m) => m[1] as string);
  expect(Arr.some(refs, Str.endsWith('.js'))).toBe(true);
  for (const ref of refs) expect([ref, (await fetch(`${server.base}${ref}`)).status]).toEqual([ref, 200]);
});

test('the licenses of the bundled code ship with the server', () => {
  const text = readFileSync(join(OUTPUT, 'server/THIRD-PARTY-LICENSES.md'), 'utf8');
  // Each heading followed by the text of its license.
  expect(text).toMatch(/^## effect - 4\.1\.4 .*\n\n\S/m);
  expect(text).toMatch(/^## @effect\/platform-node - 4\.1\.4 .*\n\n\S/m);
});
