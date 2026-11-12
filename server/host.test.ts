import { createServer, type Server } from 'node:http';
import { Hono } from 'hono';
import { afterEach, expect, test, vi } from 'vitest';
import { request } from './contract/wire';
import { mount, type WebHandler } from './host';
import { guardMw } from './http';
import { WsHub } from './ws/hub';

const web: WebHandler = (req, res) => {
  res.writeHead(200, { 'content-type': 'text/html;charset=utf-8' }).end(`web ${req.url}`);
};
const app = (tag: string) =>
  new Hono()
    .use(guardMw)
    .get('/api/x', (c) => c.json({ tag }))
    .post('/api/y', (c) => c.json({ posted: tag }));

const open: { server: Server; hub: WsHub }[] = [];
afterEach(async () => {
  for (const { server, hub } of open.splice(0)) {
    hub.dispose();
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
});

async function boot(o: { dev?: boolean; tag?: string } = {}) {
  const server = createServer();
  const hub = new WsHub('boot-1');
  open.push({ server, hub });
  const port = await mount({
    server,
    fetch: app(o.tag ?? 'one').fetch,
    hub,
    web,
    hostname: '127.0.0.1',
    port: 0,
    dev: o.dev ?? false,
  });
  return { server, hub, port, base: `http://127.0.0.1:${port}` };
}

/** The first frames a WebSocket on `/ws` receives (after sending `send`), or its close code when refused. */
function socket(base: string, headers: Record<string, string> = {}, send?: string) {
  return new Promise<{ frames: unknown[]; refused?: number }>((resolve) => {
    const ws = new WebSocket(`${base.replace(/^http/, 'ws')}/ws`, { headers } as never);
    const frames: unknown[] = [];
    ws.onmessage = (e) => {
      frames.push(JSON.parse(String(e.data)));
      if (frames.length === 1 && send) ws.send(send);
      if (frames.length === (send ? 2 : 1)) {
        ws.close();
        resolve({ frames });
      }
    };
    ws.onerror = () => resolve({ frames, refused: 1 });
  });
}

test('/api/* reaches the Hono app; any other path the web handler', async () => {
  const { base } = await boot();
  const api = await request(base, { method: 'GET', path: '/api/x' });
  expect([api.status, JSON.parse(api.body)]).toEqual([200, { tag: 'one' }]);
  const page = await request(base, { method: 'GET', path: '/chat/12' });
  expect([page.status, page.body]).toEqual([200, 'web /chat/12']);
  // `/api` alone is not an API path (Bun's `/api/*` route did not match it).
  expect((await request(base, { method: 'GET', path: '/api' })).body).toBe('web /api');
});

test('a body-less POST passes the guard over HTTP; a text body is a 415', async () => {
  const { base } = await boot();
  const bare = await request(base, { method: 'POST', path: '/api/y' });
  expect([bare.status, JSON.parse(bare.body)]).toEqual([200, { posted: 'one' }]);
  const text = await request(base, { method: 'POST', path: '/api/y', body: 'x' });
  expect(text.status).toBe(415);
});

test('a Host that is not an authority is a 403 Invalid host, as from the guard', async () => {
  const { base } = await boot();
  const res = await request(base, { method: 'GET', path: '/api/x', headers: { Host: 'a b' } });
  expect([res.status, res.headers['content-type'], JSON.parse(res.body)]).toEqual([
    403,
    'application/json;charset=utf-8',
    { error: 'Invalid host' },
  ]);
});

test('/ws without an upgrade: guarded, then 426', async () => {
  const { base } = await boot();
  for (const method of ['GET', 'POST']) {
    const res = await request(base, { method, path: '/ws' });
    expect([res.status, res.headers['content-type'], res.body]).toEqual([
      426,
      'text/plain;charset=utf-8',
      'WebSocket upgrade expected',
    ]);
  }
  const foreign = await request(base, { method: 'GET', path: '/ws', headers: { Host: 'evil.example' } });
  expect([foreign.status, JSON.parse(foreign.body)]).toEqual([403, { error: 'Host not allowed' }]);
});

test('a WebSocket on /ws gets the hub hello and its pong; a foreign Origin is refused with the guard answer', async () => {
  const { base, hub } = await boot();
  const { frames } = await socket(base, {}, JSON.stringify({ type: 'ping' }));
  expect(frames).toEqual([
    { type: 'hello', payload: { serverTime: expect.any(Number), bootId: 'boot-1' } },
    { type: 'pong' },
  ]);
  const refused = await request(base, {
    method: 'GET',
    path: '/ws',
    headers: {
      Origin: 'http://evil.example',
      Upgrade: 'websocket',
      Connection: 'Upgrade',
      'Sec-WebSocket-Version': '13',
      'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
    },
  });
  expect([refused.status, refused.headers['content-type'], JSON.parse(refused.body)]).toEqual([
    403,
    'application/json;charset=utf-8',
    { error: 'Origin not allowed' },
  ]);
  // The first client left (its close detached it), the refused one never came in.
  await vi.waitFor(() => expect(hub.size()).toBe(0));
});

test('an upgrade on another path is destroyed in production, left to the other listeners in dev', async () => {
  const prod = await boot();
  expect((await socket(prod.base)).frames.length).toBe(1); // /ws itself works
  const other = (base: string) =>
    new Promise<string>((resolve) => {
      const ws = new WebSocket(`${base.replace(/^http/, 'ws')}/other`);
      ws.onopen = () => resolve('open');
      ws.onerror = () => resolve('error');
    });
  expect(await other(prod.base)).toBe('error');
  const dev = await boot({ dev: true });
  let seen = false;
  dev.server.on('upgrade', (req, sock) => {
    if (req.url === '/other') {
      seen = true;
      sock.destroy();
    }
  });
  expect(await other(dev.base)).toBe('error');
  expect(seen).toBe(true);
});

test('a second mount on the same server swaps the listeners and does not listen again', async () => {
  const first = await boot({ tag: 'one' });
  const hub = new WsHub('boot-2');
  open.push({ server: first.server, hub });
  const port = await mount({
    server: first.server,
    fetch: app('two').fetch,
    hub,
    web,
    hostname: '127.0.0.1',
    port: 0,
    dev: false,
  });
  expect(port).toBe(first.port);
  expect(first.server.listenerCount('request')).toBe(1);
  expect(first.server.listenerCount('upgrade')).toBe(1);
  expect(JSON.parse((await request(first.base, { method: 'GET', path: '/api/x' })).body)).toEqual({ tag: 'two' });
  const { frames } = await socket(first.base);
  expect(frames).toEqual([{ type: 'hello', payload: { serverTime: expect.any(Number), bootId: 'boot-2' } }]);
});

test('a mount from a re-evaluated host module (a development reload) still replaces the listeners', async () => {
  const first = await boot({ tag: 'one' });
  vi.resetModules();
  const fresh = (await import('./host')) as typeof import('./host');
  expect(fresh.mount).not.toBe(mount);
  const hub = new WsHub('boot-2');
  open.push({ server: first.server, hub });
  await fresh.mount({
    server: first.server,
    fetch: app('two').fetch,
    hub,
    web,
    hostname: '127.0.0.1',
    port: 0,
    dev: true,
  });
  expect([first.server.listenerCount('request'), first.server.listenerCount('upgrade')]).toEqual([1, 1]);
  const { frames } = await socket(first.base);
  expect(frames).toEqual([{ type: 'hello', payload: { serverTime: expect.any(Number), bootId: 'boot-2' } }]);
});
