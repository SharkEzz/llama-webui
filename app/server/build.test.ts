// The production build (`app/.output`, built once by the server project's globalSetup): what `pnpm build` wrote.
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { Array as Arr, Option, pipe, String as Str } from 'effect';
import { afterAll, expect, test, vi } from 'vitest';
import { launch } from './testing/launch.ts';
import { tempDir } from './testing/tempDir.ts';

const OUTPUT = resolve(import.meta.dirname, '../.output');
const assets = join(OUTPUT, 'public/assets');

/** What a built module imports: `import`/`export … from`, bare `import '…'`, `import('…')` and `require('…')`. */
const specifiers = (code: string) =>
  pipe(
    [
      ...Str.matchAll(/^\s*(?:import|export)\b[^'"`;]*?\bfrom\s*["']([^"']+)["']/gm)(code),
      ...Str.matchAll(/^\s*import\s*["']([^"']+)["']/gm)(code),
      ...Str.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g)(code),
      ...Str.matchAll(/\brequire\(\s*["']([^"']+)["']\s*\)/g)(code),
    ],
    Arr.map((m) => m[1] as string),
    // `import … from '${lib}'` inside a template literal: code shown to the user (the Hugging Face snippets that
    // `@huggingface/gguf` brings), not an import.
    Arr.filter((spec) => !Str.includes('${')(spec)),
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

test('a deep URL gets the shell', async ({ signal }) => {
  const data = join(dir.path, 'deep');
  mkdirSync(data);
  await using server = await launch({ dataDir: data });
  const res = await fetch(`${server.base}/settings`, { signal });
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toContain('text/html');
  const html = await res.text();
  const refs = Arr.map([...Str.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)(html)], (m) => m[1] as string);
  expect(Arr.some(refs, Str.endsWith('.js'))).toBe(true);

  for (const ref of refs) {
    const response = await fetch(`${server.base}${ref}`, { signal });
    expect(response.status).toBe(200);
    // An unread body leaves its stream pending.
    await response.body?.cancel();
  }
});

test('each script and style over 1 KiB ships with its Brotli and gzip variants (#105)', () => {
  const files = Arr.filter(readdirSync(assets), (f) => /\.(?:js|css)$/.test(f));
  const large = Arr.filter(files, (f) => readFileSync(join(assets, f)).length > 1024);
  expect(large.length).toBeGreaterThan(10);
  for (const f of large) {
    const file = readFileSync(join(assets, f));
    expect({ f, br: brotliDecompressSync(readFileSync(join(assets, `${f}.br`))).equals(file) }).toEqual({
      f,
      br: true,
    });
    expect({ f, gz: gunzipSync(readFileSync(join(assets, `${f}.gz`))).equals(file) }).toEqual({ f, gz: true });
  }
});

test('the built server sends an asset in the encoding the client accepts (#105)', async ({ signal }) => {
  const data = join(dir.path, 'encoded');
  mkdirSync(data);
  await using server = await launch({ dataDir: data });
  const html = await (await fetch(`${server.base}/`, { signal })).text();
  const entry = Str.match(/src="(\/assets\/[^"]+\.js)"/)(html).pipe(
    Option.flatMap((m) => Option.fromUndefinedOr(m[1])),
  );
  const path = Option.getOrThrow(entry);
  const file = readFileSync(join(OUTPUT, 'public', path), 'utf8');
  for (const [encoding, expected] of [
    ['br', 'br'],
    ['gzip', 'gzip'],
    ['identity', null],
  ] as const) {
    const res = await fetch(`${server.base}${path}`, { signal, headers: { 'accept-encoding': encoding } });
    expect(res.headers.get('content-encoding')).toBe(expected);
    expect(res.headers.get('vary')).toBe('Accept-Encoding');
    // fetch decodes the body: it is the file.
    expect(await res.text()).toBe(file);
  }
});

/** The version of an installed package, as its `package.json` gives it. */
const installedVersion = (name: string): string => {
  const pkg: unknown = JSON.parse(
    readFileSync(join(import.meta.dirname, '../node_modules', name, 'package.json'), 'utf8'),
  );
  if (typeof pkg !== 'object' || pkg === null || !('version' in pkg) || typeof pkg.version !== 'string') {
    throw new Error(`${name}: no version in its package.json`);
  }
  return pkg.version;
};

test('the licenses of the bundled code ship with the server', () => {
  const text = readFileSync(join(OUTPUT, 'server/THIRD-PARTY-LICENSES.md'), 'utf8');
  // Each heading, with the version the build bundled, followed by the text of its license.
  for (const name of ['effect', '@effect/platform-node']) {
    const heading = `## ${name} - ${installedVersion(name)} `;
    expect(text).toMatch(new RegExp(`^${RegExp.escape(heading)}.*\n\n\\S`, 'm'));
  }
  expect(text).toMatch(
    /^## @scalar\/api-reference - \S+ \(MIT\)\n\nMIT License\n\nCopyright \(c\) [^\n]+ Scalar\n\nPermission is hereby granted/m,
  );
  expect(text).toMatch(/The bundle embeds these packages and keeps their license comments: [^\n]*\bvue \S+ \(MIT\)/);
});

test('the server finds the NVML sampler: the module that names it sits next to it', () => {
  const server = join(OUTPUT, 'server');
  expect(readdirSync(server)).toEqual(expect.arrayContaining(['index.mjs', 'nvml-worker.mjs']));
  // `workerPath(import.meta.url)` resolves `./nvml-worker.mjs` against its own module: in a module anywhere else, it
  // would look there, and the collectors would fall back to nvidia-smi without a word.
  const modules = (folder: string): ReadonlyArray<string> =>
    Arr.flatMap(readdirSync(folder, { withFileTypes: true }), (e) =>
      e.isDirectory() ? modules(join(folder, e.name)) : Str.endsWith('.mjs')(e.name) ? [join(folder, e.name)] : [],
    );
  const referrers = Arr.filter(
    modules(OUTPUT),
    (f) => f !== join(server, 'nvml-worker.mjs') && readFileSync(f, 'utf8').includes('nvml-worker.mjs'),
  );
  for (const f of referrers) expect(dirname(f)).toBe(server);
  // The server reaches the NVML reader (the monitor's collectors): the name of the sampler comes with it.
  expect(referrers).toEqual([join(server, 'index.mjs')]);
});

test('the NVML sampler ships next to the server entry and starts from the bundle', async () => {
  const file = join(OUTPUT, 'server/nvml-worker.mjs');
  expect(Arr.filter(specifiers(readFileSync(file, 'utf8')), (s) => !isBuiltin(s))).toEqual([]);
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', file], {
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  try {
    const lines = createInterface({ input: child.stdout });
    const first = new Promise<string>((settle, reject) => {
      const timer = setTimeout(() => reject(new Error('the bundled NVML sampler wrote no line within 5 s')), 5000);
      lines.once('line', (line) => {
        clearTimeout(timer);
        settle(line);
      });
    });
    const start = { type: 'start', intervalMs: 1000, needs: { pcie: true, skipGpus: [] } };
    child.stdin.write(`${JSON.stringify({ ...start, lib: '/no/such/libnvidia-ml.so' })}\n`);
    const reply: unknown = JSON.parse(await first);
    expect(reply).toMatchObject({ type: 'error' });
    expect(reply).toHaveProperty('message', expect.stringContaining('/no/such/'));
    // It exits once its stdin ends.
    const exited = new Promise<number | null>((settle) => child.once('exit', settle));
    child.stdin.end();
    expect(await exited).toBe(0);
  } finally {
    child.kill('SIGKILL');
  }
});
