import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { LlamaHttpError, LlamaStreamCutError } from '../src/errors.ts';
import { type ModelsSseEvent, parseModelsSseEvent, streamModelsSse } from '../src/models.ts';
import { serve } from './helpers.ts';

const frame = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;

async function collect(it: AsyncIterable<ModelsSseEvent>): Promise<ModelsSseEvent[]> {
  const out: ModelsSseEvent[] = [];
  for await (const ev of it) out.push(ev);
  return out;
}

function fakeFetch(body: string | string[], status = 200) {
  const seen: { url: string; init: RequestInit | undefined }[] = [];
  const impl = ((url: string | URL, init?: RequestInit) => {
    seen.push({ url: String(url), init });
    if (typeof body === 'string') return Promise.resolve(new Response(body, { status }));
    const enc = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        for (const b of body) c.enqueue(enc.encode(b));
        c.close();
      },
    });
    return Promise.resolve(new Response(stream, { status }));
  }) as typeof fetch;
  return { impl, seen };
}

describe('parseModelsSseEvent', () => {
  test('parses status_change loading progress, including stage-only mmproj announcement', () => {
    assert.deepEqual(
      parseModelsSseEvent({
        model: 'qwen',
        event: 'status_change',
        data: {
          status: 'loading',
          progress: { stages: ['text_model', 'mmproj_model'], current: 'text_model', value: 0.42 },
        },
      }),
      {
        event: 'status_change',
        model: 'qwen',
        status: 'loading',
        progress: { stages: ['text_model', 'mmproj_model'], current: 'text_model', value: 0.42 },
      },
    );
    assert.deepEqual(
      parseModelsSseEvent({
        model: 'qwen',
        event: 'status_change',
        data: { status: 'loading', progress: { stage: 'mmproj_model' } },
      }),
      {
        event: 'status_change',
        model: 'qwen',
        status: 'loading',
        progress: { stages: [], current: 'mmproj_model', value: null },
      },
    );
    assert.deepEqual(parseModelsSseEvent({ model: 'qwen', event: 'status_change', data: { status: 'loading' } }), {
      event: 'status_change',
      model: 'qwen',
      status: 'loading',
    });
  });

  test('parses status_change loaded with info and memory, sleeping, and unloaded with exit_code', () => {
    assert.deepEqual(
      parseModelsSseEvent({
        model: 'qwen',
        event: 'status_change',
        data: {
          status: 'loaded',
          info: { id: 'qwen' },
          memory: {
            n_ctx: 8192,
            devices: [
              {
                kind: 'device',
                name: 'CUDA0',
                total: 24_000,
                free: 10_000,
                model: 12_000,
                context: 1500,
                compute: 500,
              },
              { kind: 'host', name: 'Host', model: 0, context: 0, compute: 128 },
            ],
          },
        },
      }),
      {
        event: 'status_change',
        model: 'qwen',
        status: 'loaded',
        info: { id: 'qwen' },
        memory: {
          n_ctx: 8192,
          devices: [
            { kind: 'device', name: 'CUDA0', total: 24_000, free: 10_000, model: 12_000, context: 1500, compute: 500 },
            { kind: 'host', name: 'Host', model: 0, context: 0, compute: 128 },
          ],
        },
      },
    );
    assert.deepEqual(parseModelsSseEvent({ model: 'qwen', event: 'status_change', data: { status: 'sleeping' } }), {
      event: 'status_change',
      model: 'qwen',
      status: 'sleeping',
    });
    assert.deepEqual(
      parseModelsSseEvent({ model: 'qwen', event: 'status_change', data: { status: 'unloaded', exit_code: 1 } }),
      {
        event: 'status_change',
        model: 'qwen',
        status: 'unloaded',
        exitCode: 1,
      },
    );
  });

  test('parses download events and ignores malformed or unknown events', () => {
    assert.deepEqual(
      parseModelsSseEvent({
        model: 'hf/repo',
        event: 'download_progress',
        data: { progress: { 'https://example/m.gguf': { done: 50, total: 100 } } },
      }),
      {
        event: 'download_progress',
        model: 'hf/repo',
        progress: { 'https://example/m.gguf': { done: 50, total: 100 } },
      },
    );
    assert.deepEqual(
      parseModelsSseEvent({
        model: 'hf/repo',
        event: 'download_failed',
        data: { stopped: true },
      }),
      { event: 'download_failed', model: 'hf/repo', stopped: true },
    );
    assert.equal(parseModelsSseEvent(null), null);
    assert.equal(parseModelsSseEvent({ model: 'qwen', event: 'unknown_event' }), null);
    assert.equal(parseModelsSseEvent({ model: 'qwen', event: 'status_change', data: { status: 'bogus' } }), null);
  });
});

describe('streamModelsSse', () => {
  test('streams chunked events over HTTP and ends cleanly on EOF', async () => {
    const first = frame({
      model: 'm',
      event: 'status_change',
      data: { status: 'loading', progress: { stages: ['text_model'], current: 'text_model', value: 0.5 } },
    });
    const f = fakeFetch([
      first.slice(0, 15),
      `${first.slice(15)}data: not-json\n\n`,
      frame({ model: 'm', event: 'status_change', data: { status: 'loaded', info: { id: 'm' } } }),
    ]);
    const events = await collect(streamModelsSse('http://127.0.0.1:8080', { fetch: f.impl }));
    assert.equal(f.seen[0]?.url, 'http://127.0.0.1:8080/models/sse');
    assert.equal(events.length, 2);
    assert.equal(events[0]?.event, 'status_change');
    assert.equal(events[1]?.event, 'status_change');
  });

  test('throws LlamaHttpError on 404 or 503 (older llama-server without single-model /models/sse)', async () => {
    const f404 = fakeFetch('not found', 404);
    await assert.rejects(
      collect(streamModelsSse('http://127.0.0.1:8080', { fetch: f404.impl })),
      (e: unknown) => e instanceof LlamaHttpError && e.status === 404,
    );
    const f503 = fakeFetch('{"error":{"type":"unavailable_error"}}', 503);
    await assert.rejects(
      collect(streamModelsSse('http://127.0.0.1:8080', { fetch: f503.impl })),
      (e: unknown) => e instanceof LlamaHttpError && e.status === 503,
    );
  });

  test('throws LlamaStreamCutError when the stream breaks mid-read', async () => {
    const stream = new ReadableStream<Uint8Array>({
      pull() {
        throw new Error('reset');
      },
    });
    const impl = (() => Promise.resolve(new Response(stream, { status: 200 }))) as typeof fetch;
    await assert.rejects(collect(streamModelsSse('http://127.0.0.1:8080', { fetch: impl })), LlamaStreamCutError);
  });

  test('works against a real HTTP server', async () => {
    const server = await serve((req, res) => {
      if (req.url !== '/models/sse') return res.writeHead(404).end();
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(frame({ model: 'm', event: 'status_change', data: { status: 'sleeping' } }));
      res.end(frame({ model: 'm', event: 'status_change', data: { status: 'loaded' } }));
    });
    try {
      const events = await collect(streamModelsSse(`http://127.0.0.1:${server.port}`));
      assert.deepEqual(
        events.map((e) => (e.event === 'status_change' ? e.status : e.event)),
        ['sleeping', 'loaded'],
      );
    } finally {
      server.close();
    }
  });
});
