// The production build (`vite.config.ts`): one `vite build` into a temp dir, then what it wrote.
import { readdirSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join, resolve } from 'node:path';
import { createBuilder } from 'vite';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { request } from './contract/wire';
import { staticWeb } from './routes/web';
import { tempDir } from './testing/tempDir';

const ROOT = resolve(import.meta.dirname, '..');
const dir = tempDir('lw-build-');
const web = join(dir.path, 'web');

beforeAll(async () => {
  const builder = await createBuilder({
    configFile: join(ROOT, 'vite.config.ts'),
    logLevel: 'warn',
    environments: { client: { build: { outDir: web } }, ssr: { build: { outDir: join(dir.path, 'server') } } },
  });
  const { client } = builder.environments;
  if (!client) throw new Error('no client environment in vite.config.ts');
  await builder.build(client);
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
  server = createServer(await staticWeb(web));
  await new Promise<void>((r) => server?.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
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
