import { afterAll, describe, expect, test } from 'bun:test';
import { type ChatCompletionChunk, fetchProps, probeLlamaServer, probeUrl, streamChatCompletion } from './client.ts';
import { LlamaHttpError, LlamaReplyError, LlamaStreamCutError, LlamaStreamError } from './errors.ts';

test('probeUrl reaches a wildcard address on loopback and a specific one as is (#28)', () => {
  expect(probeUrl('0.0.0.0', 8080)).toBe('http://127.0.0.1:8080');
  expect(probeUrl(undefined, 8080)).toBe('http://127.0.0.1:8080');
  expect(probeUrl('192.168.0.20', 8080)).toBe('http://192.168.0.20:8080');
  expect(probeUrl('::', 8080)).toBe('http://[::1]:8080');
  expect(probeUrl('fe80::1', 8080)).toBe('http://[fe80::1]:8080');
  expect(probeUrl('[::1]', 8080)).toBe('http://[::1]:8080');
});

// One fake server per answer: llama-server loaded, loading, and an unrelated web server.
const servers = [
  Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => Response.json({ status: 'ok' }) }),
  Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: () =>
      Response.json({ error: { code: 503, message: 'Loading model', type: 'unavailable_error' } }, { status: 503 }),
  }),
  Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('<h1>Not Found</h1>', { status: 404 }) }),
];
afterAll(() => {
  for (const s of servers) s.stop(true);
});

test('only a service answering like llama-server counts as an external llama-server (#28)', async () => {
  const [ok, loading, other] = servers.map((s) => s.port!);
  expect(await probeLlamaServer(ok!)).toBe(true);
  expect(await probeLlamaServer(loading!)).toBe(true);
  expect(await probeLlamaServer(other!)).toBe(false);
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
    expect(chunks.map((c) => c.choices?.[0]?.delta?.content ?? null)).toEqual(['He', 'llo', null]);
    expect(chunks[2]!.timings?.predicted_per_second).toBe(4);
    expect(f.seen[0]!.url).toBe('http://h:1/v1/chat/completions');
    expect(JSON.parse(String(f.seen[0]!.init?.body))).toEqual({ messages: [], stream: true });
  });

  test('an HTTP error carries the status and llama-server JSON error', async () => {
    const body = JSON.stringify({ error: { code: 400, type: 'exceed_context_size_error', message: 'too long' } });
    const err = await collect(streamChatCompletion('http://h:1', {}, { fetch: fakeFetch(body, 400).impl })).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(LlamaHttpError);
    expect((err as LlamaHttpError).status).toBe(400);
    expect((err as LlamaHttpError).error?.type).toBe('exceed_context_size_error');
    const plain = await collect(
      streamChatCompletion('http://h:1', {}, { fetch: fakeFetch('Bad Gateway', 502).impl }),
    ).catch((e: unknown) => e);
    expect([(plain as LlamaHttpError).error, (plain as LlamaHttpError).body]).toEqual([null, 'Bad Gateway']);
  });

  test('an error event and a stream without [DONE] throw their own errors', async () => {
    const event = await collect(
      streamChatCompletion('http://h:1', {}, { fetch: fakeFetch([data({ error: { message: 'boom' } })]).impl }),
    ).catch((e: unknown) => e);
    expect(event).toBeInstanceOf(LlamaStreamError);
    expect((event as LlamaStreamError).error.message).toBe('boom');
    const cut = await collect(
      streamChatCompletion('http://h:1', {}, { fetch: fakeFetch([data({ choices: [] })]).impl }),
    ).catch((e: unknown) => e);
    expect(cut).toBeInstanceOf(LlamaStreamCutError);
  });
});

describe('fetchProps', () => {
  test('returns the JSON, or throws on an HTTP error or a reply that is not JSON', async () => {
    const f = fakeFetch('{"total_slots":2}');
    expect(await fetchProps('http://h:1', { fetch: f.impl })).toEqual({ total_slots: 2 });
    expect(f.seen[0]!.url).toBe('http://h:1/props');
    expect(await fetchProps('http://h:1', { fetch: fakeFetch('', 500).impl }).catch((e) => e)).toBeInstanceOf(
      LlamaHttpError,
    );
    expect(await fetchProps('http://h:1', { fetch: fakeFetch('<html>').impl }).catch((e) => e)).toBeInstanceOf(
      LlamaReplyError,
    );
  });
});
