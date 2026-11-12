import { createServer, type IncomingMessage, type Server, type ServerResponse, setGlobalProxyFromEnv } from 'node:http';
import type { AddressInfo } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { streamChatCompletion } from 'llamacpp-js/client';
import { afterEach, expect, test, vi } from 'vitest';
import { llamaFetch } from './llamaFetch';

const open: Server[] = [];
afterEach(async () => {
  for (const server of open.splice(0)) {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
});

async function serve(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<string> {
  const server = createServer(handler);
  open.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const bodyOf = async (req: IncomingMessage) => Buffer.concat(await req.toArray()).toString();

test('llamaFetch: sends the method, headers and body; answers a Response with the status, headers and body', async () => {
  const seen: unknown[] = [];
  const base = await serve(async (req, res) => {
    seen.push([req.method, req.url, req.headers['content-type'], req.headers['content-length'], await bodyOf(req)]);
    res.writeHead(201, { 'content-type': 'application/json', 'x-llama': 'yes' }).end('{"ok":true}');
  });
  const res = await llamaFetch(`${base}/completion?x=1`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{"prompt":"é"}',
  });
  expect(seen).toEqual([['POST', '/completion?x=1', 'application/json', '15', '{"prompt":"é"}']]);
  expect([res.status, res.ok, res.headers.get('x-llama'), await res.json()]).toEqual([201, true, 'yes', { ok: true }]);
});

test('llamaFetch: a GET by default, and an error status is a Response, not a rejection', async () => {
  const base = await serve((req, res) => {
    res.writeHead(503, { 'content-type': 'text/plain' }).end(`${req.method} loading`);
  });
  const res = await llamaFetch(new URL(`${base}/health`));
  expect([res.status, res.ok, await res.text()]).toEqual([503, false, 'GET loading']);
});

test('llamaFetch: a status without a body (204) has a null body', async () => {
  const base = await serve((_req, res) => {
    res.writeHead(204).end();
  });
  const res = await llamaFetch(base);
  expect([res.status, res.body]).toEqual([204, null]);
});

test('llamaFetch: the body is streamed as it arrives, and cancelling it closes the connection', async () => {
  let closed = false;
  let more = () => {};
  const base = await serve((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('one');
    more = () => res.write('two');
    req.socket.once('close', () => {
      closed = true;
    });
  });
  const res = await llamaFetch(base);
  const reader = res.body!.getReader();
  const text = async () => new TextDecoder().decode((await reader.read()).value);
  expect(await text()).toBe('one');
  more();
  expect(await text()).toBe('two');
  await reader.cancel();
  await vi.waitFor(() => expect(closed).toBe(true));
});

test('llamaFetch: nothing listening is a TypeError "fetch failed" with its cause, like fetch', async () => {
  const base = await serve(() => {});
  const server = open.pop()!;
  await new Promise((r) => server.close(r));
  const err = await llamaFetch(base).catch((e: unknown) => e as Error & { cause?: { code?: string } });
  expect(err).toBeInstanceOf(TypeError);
  expect([(err as Error).message, (err as { cause?: { code?: string } }).cause?.code]).toEqual([
    'fetch failed',
    'ECONNREFUSED',
  ]);
});

test('llamaFetch: a signal aborted before the answer rejects with its reason (a timeout stays a TimeoutError)', async () => {
  let closed = false;
  const base = await serve((req) => {
    req.socket.once('close', () => {
      closed = true;
    });
  });
  const err = await llamaFetch(base, { signal: AbortSignal.timeout(30) }).catch((e: unknown) => e as Error);
  expect((err as Error).name).toBe('TimeoutError');
  await vi.waitFor(() => expect(closed).toBe(true));

  const already = AbortSignal.abort(new Error('stopped'));
  await expect(llamaFetch(base, { signal: already })).rejects.toThrow('stopped');
});

test('llamaFetch: a signal aborted during the body breaks the stream with its reason', async () => {
  const base = await serve((_req, res) => {
    res.writeHead(200).write('one');
  });
  const ac = new AbortController();
  const res = await llamaFetch(base, { signal: ac.signal });
  const reader = res.body!.getReader();
  await reader.read();
  ac.abort(new Error('stopped'));
  await expect(reader.read()).rejects.toThrow('stopped');
});

test('llamaFetch: a connection cut during the body breaks the stream', async () => {
  const base = await serve((_req, res) => {
    res.writeHead(200).write('one');
    setTimeout(() => res.destroy(), 10);
  });
  const res = await llamaFetch(base);
  await expect(res.text()).rejects.toThrow();
});

test('llamaFetch: stays direct when the environment sets a proxy', async () => {
  let proxied = 0;
  const proxy = await serve((_req, res) => {
    proxied++;
    res.end('proxy');
  });
  const base = await serve((_req, res) => {
    res.end('direct');
  });
  // No NO_PROXY: Node's own fetch sends even this loopback request to the proxy.
  const restore = setGlobalProxyFromEnv({ http_proxy: proxy });
  try {
    expect(await (await fetch(base)).text()).toBe('proxy');
    expect(await (await llamaFetch(base)).text()).toBe('direct');
  } finally {
    restore();
  }
  expect(proxied).toBe(1);
});

test('llamaFetch: streamChatCompletion streams through it and stops the request when left early', async () => {
  let closed = false;
  const base = await serve(async (req, res) => {
    const body = JSON.parse(await bodyOf(req)) as { stream?: boolean };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const chunk = (content: string) => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;
    res.write(chunk(`stream=${body.stream}`));
    await sleep(10);
    res.write(chunk('b'));
    req.socket.once('close', () => {
      closed = true;
    });
  });
  const seen: string[] = [];
  for await (const j of streamChatCompletion(base, { messages: [] }, { fetch: llamaFetch })) {
    seen.push(j.choices?.[0]?.delta?.content ?? '');
    if (seen.length === 2) break;
  }
  expect(seen).toEqual(['stream=true', 'b']);
  await vi.waitFor(() => expect(closed).toBe(true));
});
