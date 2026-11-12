import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, expect, test } from 'vitest';
import { request } from '../contract/wire';
import type { WebHandler } from '../host';
import { tempDir } from '../testing/tempDir';
import { writeFileDeep } from '../testing/write';
import { staticWeb, unavailableWeb } from './web';

const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise((r) => s.close(r));
});

async function serve(handler: WebHandler): Promise<string> {
  const s = createServer(handler);
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
}

test('staticWeb: a built file is immutable with its type; any other path is the app, never cached', async () => {
  using dir = tempDir('lw-web-');
  await writeFileDeep(`${dir.path}/index.html`, '<!doctype html><title>app</title>');
  await writeFileDeep(`${dir.path}/assets/a-1.js`, 'export {};');
  await writeFileDeep(`${dir.path}/assets/f-2.woff2`, 'font');
  const base = await serve(await staticWeb(dir.path));

  const js = await request(base, { method: 'GET', path: '/assets/a-1.js' });
  expect([js.status, js.headers['content-type'], js.headers['cache-control'], js.body]).toEqual([
    200,
    'text/javascript;charset=utf-8',
    'public, max-age=31536000, immutable',
    'export {};',
  ]);
  expect((await request(base, { method: 'GET', path: '/assets/f-2.woff2' })).headers['content-type']).toBe(
    'font/woff2',
  );
  for (const path of ['/', '/chat/12', '/index.html', '/assets/missing.js', '/assets/a-1.js?v=1x']) {
    const page = await request(base, { method: 'GET', path });
    const expected = path.startsWith('/assets/a-1.js') ? 'export {};' : '<!doctype html><title>app</title>';
    expect([path, page.status, page.body]).toEqual([path, 200, expected]);
    if (expected !== 'export {};') {
      expect([page.headers['content-type'], page.headers['cache-control']]).toEqual([
        'text/html;charset=utf-8',
        'no-cache',
      ]);
    }
  }
  const head = await request(base, { method: 'HEAD', path: '/chat/12' });
  expect([head.status, head.headers['content-type'], head.body]).toEqual([200, 'text/html;charset=utf-8', '']);
});

test('staticWeb rejects without an index.html; unavailableWeb then answers every page 503 with the error', async () => {
  using dir = tempDir('lw-web-');
  const err = await staticWeb(`${dir.path}/missing`).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(Error);
  const base = await serve(unavailableWeb(err));
  const page = await request(base, { method: 'GET', path: '/chat/12' });
  expect([page.status, page.headers['content-type'], page.headers['cache-control']]).toEqual([
    503,
    'text/plain;charset=utf-8',
    'no-store',
  ]);
  expect(page.body).toContain('llama-webui: web UI unavailable.');
  expect(page.body).toContain('missing');
});

test('staticWeb: every answer has its Content-Length, HEAD included', async () => {
  using dir = tempDir('lw-web-');
  await writeFileDeep(`${dir.path}/index.html`, '<!doctype html><title>app</title>');
  await writeFileDeep(`${dir.path}/assets/a-1.js`, 'export {};');
  const base = await serve(await staticWeb(dir.path));
  for (const method of ['GET', 'HEAD']) {
    const js = await request(base, { method, path: '/assets/a-1.js' });
    const page = await request(base, { method, path: '/chat/12' });
    expect([method, js.headers['content-length'], js.headers['transfer-encoding']]).toEqual([method, '10', undefined]);
    expect([method, page.headers['content-length'], page.headers['transfer-encoding']]).toEqual([
      method,
      '33',
      undefined,
    ]);
  }
});
