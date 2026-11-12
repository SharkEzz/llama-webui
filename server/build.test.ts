// The production build (`vite.config.ts`): one `vite build` (client and server) into a temp dir, then what it wrote.
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { readdirSync, readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { isBuiltin } from 'node:module';
import { join, resolve } from 'node:path';
import { createBuilder } from 'vite';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { request } from './contract/wire';
import { staticWeb } from './routes/web';
import { listen } from './testing/listen';
import { tempDir } from './testing/tempDir';
import { webServer } from './testing/web';

const ROOT = resolve(import.meta.dirname, '..');
const dir = tempDir('lw-build-');
const web = join(dir.path, 'web');
const server_ = join(dir.path, 'server');

beforeAll(async () => {
  const builder = await createBuilder({
    configFile: join(ROOT, 'vite.config.ts'),
    logLevel: 'warn',
    environments: {
      client: { build: { outDir: web } },
      ssr: { build: { outDir: server_ } },
      nvml: { build: { outDir: server_ } },
    },
  });
  const { client, ssr, nvml } = builder.environments;
  if (!client || !ssr || !nvml) throw new Error('no client, ssr or nvml environment in vite.config.ts');
  await builder.build(client);
  await builder.build(ssr);
  await builder.build(nvml); // after ssr, which empties the directory
}, 120_000);
afterAll(() => dir[Symbol.dispose]());

test('the client is split per page, three.js only in the Topology chunks, no node:* module', () => {
  const chunks = readdirSync(join(web, 'assets')).filter((f) => f.endsWith('.js'));
  expect(chunks.length).toBeGreaterThan(10);
  const html = readFileSync(join(web, 'index.html'), 'utf8');
  const entry = html.match(/<script type="module"[^>]*src="\/assets\/([^"]+\.js)"/)?.[1];
  expect(entry).toBeDefined();
  const read = (f: string) => readFileSync(join(web, 'assets', f), 'utf8');
  expect(read(entry as string)).not.toContain('WebGLRenderer');
  expect(chunks.filter((c) => read(c).includes('WebGLRenderer')).length).toBeGreaterThan(0);
  // The browser has no `node:*` module: one in the bundle means server code leaked past the typed client.
  expect(chunks.filter((c) => /(?:from|import)\s*\(?\s*["']node:/.test(read(c)))).toEqual([]);
});

let server: Server | undefined;
afterAll(() => server?.close());

test('served by staticWeb, a deep URL finds every file its page references, from the root', async () => {
  server = webServer(await staticWeb(web));
  const base = await listen(server);
  const page = await request(base, { method: 'GET', path: '/chat/12' });
  expect(page.headers['cache-control']).toBe('no-cache');
  const refs = [...page.body.matchAll(/(?:src|href)="([^"]+\.(?:js|css|svg))"/g)].map((m) => m[1] as string);
  expect(refs.some((r) => r.endsWith('.js')) && refs.some((r) => r.endsWith('.css'))).toBe(true);
  for (const ref of refs) {
    expect(ref.startsWith('/')).toBe(true);
    const res = await request(base, { method: 'GET', path: ref });
    expect([ref, res.status, res.headers['cache-control']]).toEqual([ref, 200, 'public, max-age=31536000, immutable']);
  }
});

/** What a built server module imports: static `import`/`export … from` statements and `import('…')`. */
const specifiers = (code: string) =>
  [
    ...code.matchAll(/^\s*(?:import|export)\b[^'"`;]*?\bfrom\s*["']([^"']+)["']/gm),
    ...code.matchAll(/^\s*import\s*["']([^"']+)["']/gm),
    ...code.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g),
  ]
    .map((m) => m[1] as string)
    // `import("${lib}")` inside a template literal: code shown to the user (Hugging Face snippets), not an import.
    .filter((spec) => !spec.includes('${'));

test('the server bundle: main.js, only node:* and the network-facing dependencies left out, licenses shipped', () => {
  const files = readdirSync(server_, { recursive: true }).map(String);
  expect(files).toContain('main.js');
  expect(files).toContain('THIRD-PARTY-LICENSES.md');
  // Node's built-in modules, with or without `node:` (a bundled dependency may write `fs`).
  const allowed = (spec: string) =>
    isBuiltin(spec) || /^(?:hono(?:\/|$)|@hono\/node-server(?:\/|$)|ws(?:\/|$)|\.{1,2}\/)/.test(spec);
  const external = files
    .filter((f) => f.endsWith('.js'))
    .flatMap((f) => specifiers(readFileSync(join(server_, f), 'utf8')).map((s) => `${f}: ${s}`))
    .filter((line) => !allowed(line.slice(line.indexOf(': ') + 2)));
  expect(external).toEqual([]);
  expect(readFileSync(join(server_, 'main.js'), 'utf8').startsWith('#!/usr/bin/env node')).toBe(true);
});

test('the NVML sampler ships next to main.js and starts from the bundle', async () => {
  expect(readdirSync(server_).filter((f) => f.endsWith('.js'))).toEqual(['main.js', 'nvml-worker.js']);
  const file = join(server_, 'nvml-worker.js');
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
