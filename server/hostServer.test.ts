import type { Server } from 'node:http';
import { connect, createServer as createHttp2Server, type Http2Server } from 'node:http2';
import { afterEach, expect, test, vi } from 'vitest';
import { request } from './contract/wire';
import { createHostServer, HOST_APP, type HostServer } from './hostServer';
import { listen } from './testing/listen';

const open: (Server | Http2Server)[] = [];
afterEach(async () => {
  for (const s of open.splice(0)) await new Promise((r) => s.close(r));
});

/** A host server whose app records its calls and answers 200. */
async function host() {
  const server: HostServer = createHostServer();
  const app = vi.fn(() => new Response('app'));
  server[HOST_APP] = app;
  open.push(server);
  return { server, app, base: await listen(server) };
}

/** One HTTP/2 request over cleartext (h2c, prior knowledge): its status and body, or the session's error. */
function h2(base: string, path = '/') {
  return new Promise<{ status: number; body: string } | { error: string }>((resolve) => {
    const session = connect(base);
    session.on('error', (err) => resolve({ error: (err as NodeJS.ErrnoException).code ?? err.message }));
    const req = session.request({ ':path': path });
    req.on('error', (err) => resolve({ error: (err as NodeJS.ErrnoException).code ?? err.message }));
    let status = 0;
    let body = '';
    req.on('response', (headers) => {
      status = Number(headers[':status']);
    });
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      body += chunk;
    });
    req.on('end', () => {
      session.close();
      resolve({ status, body });
    });
  });
}

test('the host server speaks HTTP/1 only: an HTTP/2 client gets no answer from the app', async () => {
  const { base, app } = await host();
  // Node's HTTP/1 parser refuses the HTTP/2 preface: the client sees a protocol error.
  expect(await h2(base, '/api/x')).toEqual({ error: 'ERR_HTTP2_ERROR' });
  expect(app).not.toHaveBeenCalled();
  // The same server still answers HTTP/1.
  expect((await request(base, { method: 'GET', path: '/api/x' })).body).toBe('app');
  expect(app).toHaveBeenCalledOnce();
});

test('HTTP/2 bindings never reach the app: the adapter answers 505', async () => {
  const { server, app } = await host();
  // Real HTTP/2 requests, handed to the host server's own listener (the adapter's).
  const h2Server = createHttp2Server((req, res) => server.emit('request', req, res));
  open.push(h2Server);
  const base = await new Promise<string>((resolve) =>
    h2Server.listen(0, '127.0.0.1', () => {
      const address = h2Server.address();
      resolve(`http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`);
    }),
  );
  expect(await h2(base, '/api/x')).toEqual({ status: 505, body: 'HTTP/1 expected' });
  expect(app).not.toHaveBeenCalled();
});
