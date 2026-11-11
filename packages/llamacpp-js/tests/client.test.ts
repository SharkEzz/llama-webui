import assert from 'node:assert/strict';
import type { ServerResponse } from 'node:http';
import { after, describe, test } from 'node:test';
import {
  type ChatCompletionChunk,
  fetchLlama,
  fetchProps,
  probeHealth,
  probeLlamaServer,
  probeUrl,
  streamChatCompletion,
} from '../src/client.ts';
import { LlamaHttpError, LlamaReplyError, LlamaStreamCutError, LlamaStreamError } from '../src/errors.ts';
import { fixture, serve } from './helpers.ts';

test('probeUrl reaches a wildcard address on loopback and a specific one as is (#28)', () => {
  assert.equal(probeUrl('0.0.0.0', 8080), 'http://127.0.0.1:8080');
  assert.equal(probeUrl(undefined, 8080), 'http://127.0.0.1:8080');
  assert.equal(probeUrl('192.168.0.20', 8080), 'http://192.168.0.20:8080');
  assert.equal(probeUrl('::', 8080), 'http://[::1]:8080');
  assert.equal(probeUrl('fe80::1', 8080), 'http://[fe80::1]:8080');
  assert.equal(probeUrl('[::1]', 8080), 'http://[::1]:8080');
});

// One fake server per answer: llama-server loaded, loading, and an unrelated web server.
const json = (status: number, body: unknown) => (_: unknown, res: ServerResponse) =>
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
const servers = await Promise.all([
  serve(json(200, { status: 'ok' })),
  serve(json(503, { error: { code: 503, message: 'Loading model', type: 'unavailable_error' } })),
  serve((_, res) => res.writeHead(404, { 'content-type': 'text/html' }).end('<h1>Not Found</h1>')),
]);
after(() => {
  for (const s of servers) s.close();
});

test('only a service answering like llama-server counts as an external llama-server (#28)', async () => {
  const [ok, loading, other] = servers.map((s) => s.port);
  assert.equal(await probeLlamaServer(ok!), true);
  assert.equal(await probeLlamaServer(loading!), true);
  assert.equal(await probeLlamaServer(other!), false);
});

test('the client reads a llama-server over HTTP: health, /slots, /metrics, /props and a stream', async () => {
  const [metrics, slots] = await Promise.all([fixture('metrics-after.txt'), fixture('slots-busy.json')]);
  const server = await serve((req, res) => {
    if (req.url === '/health') return json(200, { status: 'ok' })(req, res);
    if (req.url === '/slots') return res.writeHead(200, { 'content-type': 'application/json' }).end(slots);
    if (req.url === '/metrics') return res.writeHead(200).end(metrics);
    if (req.url === '/props') return json(200, { total_slots: 1 })(req, res);
    if (req.url !== '/v1/chat/completions') return res.writeHead(404).end();
    let body = '';
    req.on('data', (c: Buffer) => {
      body += c.toString();
    });
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      if (JSON.parse(body).fail) return res.end(`data: ${JSON.stringify({ error: { message: 'boom' } })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Hi' } }] })}\n\n`);
      res.end('data: [DONE]\n\n');
    });
  });
  try {
    const base = probeUrl('127.0.0.1', server.port);
    assert.equal(await probeHealth(server.port, fetch, '127.0.0.1'), 200);
    const raw = await fetchLlama(base);
    assert.equal(raw.health, 'ok');
    assert.ok(raw.slots && raw.slots.length > 0);
    assert.ok(raw.metrics && raw.metrics.size > 0);
    assert.deepEqual(await fetchProps(base), { total_slots: 1 });
    const chunks = await collect(streamChatCompletion(base, { messages: [] }));
    assert.deepEqual(
      chunks.map((c) => c.choices?.[0]?.delta?.content),
      ['Hi'],
    );
    await assert.rejects(collect(streamChatCompletion(base, { fail: true })), LlamaStreamError);
  } finally {
    server.close();
  }
});

/** A fetch that answers `body` (a string, or the chunks of a stream) with `status`, and records the request. */
function fakeFetch(body: string | string[], status = 200) {
  const seen: { url: string; init: RequestInit | undefined }[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(url), init });
    if (typeof body === 'string') return new Response(body, { status });
    const enc = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        for (const b of body) c.enqueue(enc.encode(b));
        c.close();
      },
    });
    return new Response(stream, { status });
  }) as typeof fetch;
  return { impl, seen };
}

const data = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;

async function collect(it: AsyncIterable<ChatCompletionChunk>): Promise<ChatCompletionChunk[]> {
  const out: ChatCompletionChunk[] = [];
  for await (const c of it) out.push(c);
  return out;
}

describe('streamChatCompletion', () => {
  test('posts the body with stream on and yields each chunk until [DONE]', async () => {
    const f = fakeFetch([
      data({ choices: [{ delta: { content: 'He' } }] }),
      `${data({ choices: [{ delta: { content: 'llo' } }] }).slice(0, 10)}`,
      `${data({ choices: [{ delta: { content: 'llo' } }] }).slice(10)}: keep-alive\n\n`,
      data({
        choices: [{ delta: {} }],
        timings: { prompt_n: 1, prompt_per_second: 2, predicted_n: 3, predicted_per_second: 4 },
      }),
      'data: [DONE]\n\n',
    ]);
    const chunks = await collect(streamChatCompletion('http://h:1', { messages: [] }, { fetch: f.impl }));
    assert.deepEqual(
      chunks.map((c) => c.choices?.[0]?.delta?.content ?? null),
      ['He', 'llo', null],
    );
    assert.equal(chunks[2]!.timings?.predicted_per_second, 4);
    assert.equal(f.seen[0]!.url, 'http://h:1/v1/chat/completions');
    assert.deepEqual(JSON.parse(String(f.seen[0]!.init?.body)), { messages: [], stream: true });
  });

  test('an HTTP error carries the status and llama-server JSON error', async () => {
    const body = JSON.stringify({ error: { code: 400, type: 'exceed_context_size_error', message: 'too long' } });
    await assert.rejects(collect(streamChatCompletion('http://h:1', {}, { fetch: fakeFetch(body, 400).impl })), {
      name: 'LlamaHttpError',
      status: 400,
      error: { code: 400, type: 'exceed_context_size_error', message: 'too long' },
    });
    await assert.rejects(
      collect(streamChatCompletion('http://h:1', {}, { fetch: fakeFetch('Bad Gateway', 502).impl })),
      {
        name: 'LlamaHttpError',
        error: null,
        body: 'Bad Gateway',
      },
    );
  });

  test('an error event and a stream without [DONE] throw their own errors', async () => {
    const event = fakeFetch([data({ error: { message: 'boom' } })]).impl;
    await assert.rejects(collect(streamChatCompletion('http://h:1', {}, { fetch: event })), (e) => {
      assert.ok(e instanceof LlamaStreamError);
      assert.equal(e.error.message, 'boom');
      return true;
    });
    const cut = fakeFetch([data({ choices: [] })]).impl;
    await assert.rejects(collect(streamChatCompletion('http://h:1', {}, { fetch: cut })), LlamaStreamCutError);
  });
});

describe('fetchProps', () => {
  test('returns the JSON, or throws on an HTTP error or a reply that is not JSON', async () => {
    const f = fakeFetch('{"total_slots":2}');
    assert.deepEqual(await fetchProps('http://h:1', { fetch: f.impl }), { total_slots: 2 });
    assert.equal(f.seen[0]!.url, 'http://h:1/props');
    await assert.rejects(fetchProps('http://h:1', { fetch: fakeFetch('', 500).impl }), LlamaHttpError);
    await assert.rejects(fetchProps('http://h:1', { fetch: fakeFetch('<html>').impl }), LlamaReplyError);
  });
});
