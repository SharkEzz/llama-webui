import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { readSse, request } from './wire';

let base = '';
let seen: IncomingMessage['headers'] = {};
const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  seen = req.headers;
  const chunks: Buffer[] = [];
  req.on('data', (c: Buffer) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString();
    if (req.url === '/len') return res.writeHead(200, { 'content-type': 'text/plain' }).end(`got:${body}`);
    if (req.url === '/chunked') {
      res.writeHead(201, { 'content-type': 'application/json' });
      res.write('{"a":');
      res.write('1}');
      return res.end();
    }
    if (req.url === '/empty') return res.writeHead(204).end();
    if (req.url === '/head') return res.writeHead(200, { 'content-type': 'application/json' }).end('{"x":1}');
    if (req.url === '/sse') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('event: hello\ndata: {}\n\n');
      return; // never ends
    }
    res.writeHead(404).end();
  });
});

beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => {
  server.closeAllConnections();
  server.close();
});

test('a body is sent with its content-length; the reply keeps its status, lower-case headers and body', async () => {
  const r = await request(base, {
    method: 'POST',
    path: '/len',
    body: 'hé',
    headers: { 'Content-Type': 'text/plain' },
  });
  expect(r).toEqual({
    status: 200,
    headers: expect.objectContaining({ 'content-type': 'text/plain' }),
    body: 'got:hé',
  });
  expect(seen['content-length']).toBe('3');
});

test('a chunked reply is reassembled', async () => {
  const r = await request(base, { method: 'GET', path: '/chunked' });
  expect([r.status, r.body, r.headers['transfer-encoding']]).toEqual([201, '{"a":1}', 'chunked']);
});

test('a 204 and a HEAD reply have an empty body', async () => {
  expect((await request(base, { method: 'DELETE', path: '/empty' })).body).toBe('');
  const head = await request(base, { method: 'HEAD', path: '/head' });
  expect([head.status, head.body, head.headers['content-type']]).toEqual([200, '', 'application/json']);
});

test('a request without body sends neither content-length nor transfer-encoding; headers are sent as given', async () => {
  await request(base, { method: 'DELETE', path: '/empty', headers: { Host: 'evil.example', Origin: 'http://x' } });
  expect(seen['content-length']).toBeUndefined();
  expect(seen['transfer-encoding']).toBeUndefined();
  expect([seen.host, seen.origin]).toEqual(['evil.example', 'http://x']);
  await request(base, { method: 'POST', path: '/empty', headers: { 'Content-Length': '0' } });
  expect(seen['content-length']).toBe('0');
});

test('readSse stops at the condition on a stream that never ends', async () => {
  const r = await readSse(base, { method: 'GET', path: '/sse' }, (t) => t.includes('\n\n'));
  expect([r.status, r.headers['content-type'], r.body]).toEqual([
    200,
    'text/event-stream',
    'event: hello\ndata: {}\n\n',
  ]);
});
