import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { serveDist } from './serve.ts';

const FILES: Record<string, string | Buffer> = {
  'index.html': '<h1>home</h1>',
  'docs/index.html': '<h1>docs</h1>',
  'docs/deep/index.html': '<h1>deep</h1>',
  'assets/a.css': 'body { color: red; }',
  'assets/x.pf_meta': Buffer.from([0x62, 0x69, 0x6e, 0x00]),
  'assets/sp ace.txt': 'spaced',
  'sitemap.xml': '<urlset/>',
  '404.html': '<h1>404</h1>',
};

let dist: string;
let base: string;
let server: ReturnType<typeof serveDist>;

beforeAll(async () => {
  dist = mkdtempSync(join(tmpdir(), 'site-serve-'));
  for (const [path, content] of Object.entries(FILES)) {
    mkdirSync(dirname(join(dist, path)), { recursive: true });
    writeFileSync(join(dist, path), content);
  }
  server = serveDist(dist);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.close();
  rmSync(dist, { recursive: true, force: true });
});

/** A raw request: no automatic decompression, the path sent as is. */
function get(path: string, headers: Record<string, string> = {}, method = 'GET') {
  return new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: Buffer }>(
    (resolve, reject) => {
      const req = request(`${base}${path}`, { method, headers }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }),
        );
      });
      req.on('error', reject);
      req.end();
    },
  );
}

describe('serve.ts', () => {
  test('redirects to the trailing slash like GitHub Pages', async () => {
    for (const path of ['/', '/llama-webui']) {
      const res = await get(path);
      expect(res.status).toBe(301);
      expect(res.headers.location).toBe('/llama-webui/');
    }
    const res = await get('/llama-webui/docs?x=1');
    expect(res.status).toBe(301);
    expect(res.headers.location).toBe('/llama-webui/docs/?x=1');
  });

  test('serves files with their type and a 10 minute cache', async () => {
    const page = await get('/llama-webui/docs/deep/');
    expect(page.status).toBe(200);
    expect(page.headers['content-type']).toBe('text/html;charset=utf-8');
    expect(page.headers['cache-control']).toBe('max-age=600');
    expect(page.body.toString()).toBe('<h1>deep</h1>');
    expect((await get('/llama-webui/')).body.toString()).toBe('<h1>home</h1>');
    expect((await get('/llama-webui/sitemap.xml')).headers['content-type']).toBe('application/xml');
    const bin = await get('/llama-webui/assets/x.pf_meta');
    expect(bin.headers['content-type']).toBe('application/octet-stream');
    expect(bin.body).toEqual(FILES['assets/x.pf_meta']);
    const spaced = await get('/llama-webui/assets/sp%20ace.txt');
    expect(spaced.status).toBe(200);
    expect(spaced.headers['content-type']).toBe('text/plain;charset=utf-8');
    expect(spaced.body.toString()).toBe('spaced');
  });

  test('gzips text only, when accepted', async () => {
    const css = await get('/llama-webui/assets/a.css', { 'accept-encoding': 'gzip, br' });
    expect(css.headers['content-type']).toBe('text/css;charset=utf-8');
    expect(css.headers['content-encoding']).toBe('gzip');
    expect(css.headers.vary).toBe('accept-encoding');
    expect(gunzipSync(css.body).toString()).toBe(FILES['assets/a.css']);
    const plain = await get('/llama-webui/assets/a.css');
    expect(plain.headers['content-encoding']).toBeUndefined();
    expect(plain.body.toString()).toBe(FILES['assets/a.css']);
    const bin = await get('/llama-webui/assets/x.pf_meta', { 'accept-encoding': 'gzip' });
    expect(bin.headers['content-encoding']).toBeUndefined();
    expect(bin.body).toEqual(FILES['assets/x.pf_meta']);
  });

  test('answers 404.html for an unknown page, Not found outside the base', async () => {
    for (const path of ['/llama-webui/nope', '/llama-webui/nope/', '/llama-webui/assets', '/llama-webui/assets/']) {
      const res = await get(path);
      expect(res.status, path).toBe(404);
      expect(res.headers['content-type']).toBe('text/html;charset=utf-8');
      expect(res.body.toString()).toBe('<h1>404</h1>');
    }
    for (const path of ['/other', '/llama-webui/../etc/passwd', '/llama-webui/%2e%2e/%2e%2e/etc/passwd']) {
      const res = await get(path);
      expect(res.status, path).toBe(404);
      expect(res.headers['content-type']).toBe('text/plain;charset=utf-8');
      expect(res.body.toString()).toBe('Not found');
    }
  });

  test('HEAD sends the headers only', async () => {
    const res = await get('/llama-webui/', {}, 'HEAD');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('text/html;charset=utf-8');
    expect(res.headers['content-length']).toBe(String('<h1>home</h1>'.length));
    expect(res.body.length).toBe(0);
  });
});
