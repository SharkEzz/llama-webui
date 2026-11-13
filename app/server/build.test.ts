// The production build (`app/.output`, built once by the server project's globalSetup): what `vite build` wrote.
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { readdirSync, readFileSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import { join, resolve } from 'node:path';
import { afterAll, expect, test } from 'vitest';
import { launch } from './lib/testing/launch';
import { tempDir } from './lib/testing/tempDir';

const OUTPUT = resolve(import.meta.dirname, '../.output');
const assets = join(OUTPUT, 'public/assets');
const server = join(OUTPUT, 'server');

/** What a built module imports: static `import`/`export … from` statements and `import('…')`. */
const specifiers = (code: string) =>
  [
    ...code.matchAll(/^\s*(?:import|export)\b[^'"`;]*?\bfrom\s*["']([^"']+)["']/gm),
    ...code.matchAll(/^\s*import\s*["']([^"']+)["']/gm),
    ...code.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g),
  ]
    .map((m) => m[1] as string)
    // `import("${lib}")` inside a template literal: code shown to the user (Hugging Face snippets), not an import.
    .filter((spec) => !spec.includes('${'));

const dir = tempDir('lw-build-');
afterAll(() => dir[Symbol.dispose]());

test('the client is split per page, three.js only in the Topology chunks, no node:* module', async () => {
  const chunks = readdirSync(assets).filter((f) => f.endsWith('.js'));
  expect(chunks.length).toBeGreaterThan(10);
  await using app = await launch({ dataDir: dir.path, env: { LLAMA_WEBUI_TEST_MONITOR: 'stub' } });
  const html = await (await fetch(`${app.base}/`)).text();
  const entry = html.match(/<script type="module"[^>]*src="\/assets\/([^"]+\.js)"/)?.[1];
  expect(entry).toBeDefined();
  const read = (f: string) => readFileSync(join(assets, f), 'utf8');
  expect(read(entry as string)).not.toContain('WebGLRenderer');
  expect(chunks.filter((c) => read(c).includes('WebGLRenderer')).length).toBeGreaterThan(0);
  // The browser has no `node:*` module: one in the bundle means server code leaked into the client.
  expect(chunks.filter((c) => /(?:from|import)\s*\(?\s*["']node:/.test(read(c)))).toEqual([]);
});

test('a deep URL finds every file its page references, from the root, cached as immutable', async () => {
  await using app = await launch({ dataDir: dir.path, env: { LLAMA_WEBUI_TEST_MONITOR: 'stub' } });
  const html = await (await fetch(`${app.base}/chat/12`)).text();
  const refs = [...html.matchAll(/(?:src|href)="([^"]+\.(?:js|css|svg))"/g)].map((m) => m[1] as string);
  expect(refs.some((r) => r.endsWith('.js')) && refs.some((r) => r.endsWith('.css'))).toBe(true);
  for (const ref of refs) {
    expect(ref.startsWith('/')).toBe(true);
    const res = await fetch(`${app.base}${ref}`);
    expect([ref, res.status, res.headers.get('cache-control')]).toEqual([
      ref,
      200,
      'public, max-age=31536000, immutable',
    ]);
  }
});

test('the server imports nothing but node:* builtins: the build is self-contained', () => {
  const files = readdirSync(OUTPUT, { recursive: true })
    .map(String)
    .filter((f) => f.endsWith('.mjs'));
  expect(files).toContain('llama-webui.mjs');
  const external = files
    .flatMap((f) => specifiers(readFileSync(join(OUTPUT, f), 'utf8')).map((s) => `${f}: ${s}`))
    // Node's built-in modules, with or without `node:` (a bundled dependency may write `fs`), and relative chunks.
    .filter((line) => {
      const spec = line.slice(line.indexOf(': ') + 2);
      return !isBuiltin(spec) && !/^\.{1,2}\//.test(spec);
    });
  expect(external).toEqual([]);
  expect(readFileSync(join(OUTPUT, 'llama-webui.mjs'), 'utf8').startsWith('#!/usr/bin/env node')).toBe(true);
});

test('the licenses of the bundled code ship with the server', () => {
  const text = readFileSync(join(server, 'THIRD-PARTY-LICENSES.md'), 'utf8');
  for (const name of ['h3', 'srvx', 'crossws', 'zod']) expect(text).toMatch(new RegExp(`^## ${name} `, 'm'));
});

/** The built modules (paths relative to `dir`) whose code names `nvml-worker.mjs`, the sampler itself left out. */
function samplerReferrers(dir: string): string[] {
  return (readdirSync(dir, { recursive: true }) as string[])
    .filter((f) => f.endsWith('.mjs') && f !== 'nvml-worker.mjs')
    .filter((f) => readFileSync(join(dir, f), 'utf8').includes('nvml-worker.mjs'))
    .sort();
}

test('the server finds the NVML sampler: the module that names it sits next to it', () => {
  // `workerUrl()` resolves `./nvml-worker.mjs` against its own module: in a chunk under `_chunks/`, it would look there,
  // and the monitor would fall back to nvidia-smi without a word.
  const referrers = samplerReferrers(server);
  expect(referrers.length).toBeGreaterThan(0);
  for (const f of referrers) expect(f).not.toContain('/');
});

test('the NVML sampler ships next to the server entry and starts from the bundle', async () => {
  const file = join(server, 'nvml-worker.mjs');
  expect(specifiers(readFileSync(file, 'utf8')).filter((s) => !isBuiltin(s))).toEqual([]);
  const child = fork(file, [], { execArgv: ['--disable-warning=ExperimentalWarning'], serialization: 'advanced' });
  try {
    const answer = once(child, 'message');
    child.send({ type: 'start', intervalMs: 1000, lib: '/nonexistent/libnvidia-ml.so.1' });
    expect((await answer)[0]).toMatchObject({ type: 'error', message: expect.stringContaining('/nonexistent/') });
  } finally {
    child.kill('SIGKILL');
  }
});
