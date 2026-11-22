/**
 * HTTP client for llama-server: health probes, the monitoring reads, `/props` and streamed chat completions. Only
 * `fetch` (injectable everywhere, for tests or another transport), so it runs in Node and in browsers.
 */
import {
  isLlamaError,
  type LlamaError,
  LlamaHttpError,
  LlamaReplyError,
  LlamaStreamCutError,
  LlamaStreamError,
} from './errors.ts';
import { type Health, type LlamaRaw, parsePrometheus, parseSlots } from './metrics.ts';
import { SseParser } from './sse.ts';

const PROBE_TIMEOUT_MS = 800;

/**
 * Base URL to reach a llama-server listening on `host`:`port` from this machine. A wildcard address (`0.0.0.0`, `::`)
 * or none means loopback; a specific address (a LAN IP) is used as is, since llama-server then refuses loopback
 * connections (#28). IPv6 addresses get their brackets.
 */
export function probeUrl(host: string | null | undefined, port: number): string {
  const h = (host ?? '').trim().replace(/^\[|\]$/g, '');
  const target = h === '' || h === '0.0.0.0' ? '127.0.0.1' : h === '::' ? '::1' : h;
  return `http://${target.includes(':') ? `[${target}]` : target}:${port}`;
}

/**
 * The status llama-server's /health answers on `host`:`port` (200 once loaded, 503 while loading), or null
 * when nothing answers within 800 ms. Shared by the Supervisor and the benchmark: one rule for "a server is
 * on the port" and one for "it is ready".
 */
export async function probeHealth(
  port: number,
  fetchImpl: typeof fetch = fetch,
  host?: string | null,
): Promise<number | null> {
  try {
    const r = await fetchImpl(`${probeUrl(host, port)}/health`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    await r.body?.cancel().catch(() => {});
    return r.status;
  } catch {
    return null;
  }
}

/**
 * True when the service on the port is a llama-server: its /health answers JSON, `{"status":"ok"}` once loaded or
 * `{"error":{"type":"unavailable_error",…}}` while loading. Any other HTTP service (a web server, another API) is not
 * an external llama-server (#28).
 */
export async function probeLlamaServer(
  port: number,
  fetchImpl: typeof fetch = fetch,
  host?: string | null,
): Promise<boolean> {
  try {
    const r = await fetchImpl(`${probeUrl(host, port)}/health`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    const body: unknown = await r.json().catch(() => null);
    if (!body || typeof body !== 'object') return false;
    if ('status' in body && typeof body.status === 'string') return true;
    const error = 'error' in body ? body.error : undefined;
    return typeof error === 'object' && error !== null && 'type' in error && error.type === 'unavailable_error';
  } catch {
    return false;
  }
}

function get(url: string, fetchImpl: typeof fetch, timeoutMs: number): Promise<Response> {
  return fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
}

/** One monitoring read of the server at `baseUrl`: `/health`, then `/slots` and `/metrics` once it is loaded. */
export async function fetchLlama(baseUrl: string, fetchImpl: typeof fetch = fetch, timeoutMs = 800): Promise<LlamaRaw> {
  const at = Date.now();
  let health: Health;
  try {
    const r = await get(`${baseUrl}/health`, fetchImpl, timeoutMs);
    health = r.status === 200 ? 'ok' : r.status === 503 ? 'loading' : 'error';
    await r.body?.cancel().catch(() => {});
  } catch {
    return { at, health: 'down', slots: null, metrics: null };
  }
  if (health !== 'ok') return { at, health, slots: null, metrics: null };
  const [slots, metrics] = await Promise.all([
    get(`${baseUrl}/slots`, fetchImpl, timeoutMs)
      .then((r) => r.json())
      .then(parseSlots)
      .catch(() => null),
    get(`${baseUrl}/metrics`, fetchImpl, timeoutMs)
      .then((r) => r.text())
      .then(parsePrometheus)
      .catch(() => null),
  ]);
  return { at, health, slots, metrics };
}

export interface RequestOptions {
  fetch?: typeof fetch;
  signal?: AbortSignal;
}

/**
 * The server's `/props` (model, context, chat template, default generation settings…) as it sends it. Throws
 * `LlamaHttpError` on an HTTP error, `LlamaReplyError` when the reply is not JSON, and the `fetch` error when nothing
 * answers (2 s by default).
 */
export async function fetchProps(baseUrl: string, o: RequestOptions & { timeoutMs?: number } = {}): Promise<unknown> {
  const signal = o.signal ?? AbortSignal.timeout(o.timeoutMs ?? 2000);
  const r = await (o.fetch ?? fetch)(`${baseUrl}/props`, { signal });
  if (!r.ok) throw new LlamaHttpError(r.status, await r.text().catch(() => ''));
  return r.json().catch(() => {
    throw new LlamaReplyError('the reply is not JSON');
  });
}

/** The `timings` llama-server adds to a completion (the last chunk of a stream). */
export interface LlamaTimings {
  prompt_n: number;
  prompt_per_second: number;
  predicted_n: number;
  predicted_per_second: number;
  cache_n?: number;
  draft_n?: number;
  draft_n_accepted?: number;
}

/** One event of a streamed `/v1/chat/completions`, as far as llama-server fills it. */
export interface ChatCompletionChunk {
  choices?: { delta?: { content?: string | null; reasoning_content?: string | null } }[];
  timings?: LlamaTimings;
  error?: LlamaError;
}

/** `v` is a chunk: an object whose fields, when present, have their type. */
function isChunk(v: unknown): v is ChatCompletionChunk {
  if (typeof v !== 'object' || v === null) return false;
  const field = (o: object, key: string): unknown => Reflect.get(o, key);
  const isObject = (x: unknown): x is object => typeof x === 'object' && x !== null;
  const text = (x: unknown) => x === undefined || x === null || typeof x === 'string';
  const choice = (c: unknown) => {
    if (!isObject(c)) return false;
    const delta = field(c, 'delta');
    return (
      delta === undefined ||
      (isObject(delta) && text(field(delta, 'content')) && text(field(delta, 'reasoning_content')))
    );
  };
  const timings = (t: unknown) => {
    if (t === undefined) return true;
    if (!isObject(t)) return false;
    const n = (key: keyof LlamaTimings, optional: boolean) => {
      const x = field(t, key);
      return typeof x === 'number' || (optional && x === undefined);
    };
    return (
      n('prompt_n', false) &&
      n('prompt_per_second', false) &&
      n('predicted_n', false) &&
      n('predicted_per_second', false) &&
      n('cache_n', true) &&
      n('draft_n', true) &&
      n('draft_n_accepted', true)
    );
  };
  const choices = field(v, 'choices');
  const error = field(v, 'error');
  return (
    (choices === undefined || (Array.isArray(choices) && choices.every(choice))) &&
    timings(field(v, 'timings')) &&
    (error === undefined || isLlamaError(error))
  );
}

/**
 * Streams `/v1/chat/completions` (`body` is sent as is, with `stream: true`): yields each chunk until `[DONE]`.
 * Throws the `fetch` error when the server cannot be reached, `LlamaHttpError` when it refuses the request,
 * `LlamaStreamError` on an error event, and `LlamaStreamCutError` when the stream ends or breaks before `[DONE]`.
 * Aborting `signal` stops the request; leaving the loop before `[DONE]` cancels the stream.
 */
export async function* streamChatCompletion(
  baseUrl: string,
  body: Record<string, unknown>,
  o: RequestOptions = {},
): AsyncGenerator<ChatCompletionChunk, void, undefined> {
  const res = await (o.fetch ?? fetch)(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...body, stream: true }),
    ...(o.signal ? { signal: o.signal } : {}),
  });
  if (!res.ok || !res.body) throw new LlamaHttpError(res.status, await res.text().catch(() => ''));
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const parser = new SseParser();
  let finished = false;
  try {
    for (;;) {
      let chunk: Awaited<ReturnType<typeof reader.read>>;
      try {
        chunk = await reader.read();
      } catch (cause) {
        throw new LlamaStreamCutError('the stream broke', { cause });
      }
      if (chunk.done) throw new LlamaStreamCutError('the stream ended before [DONE]');
      // A fetch body's chunks are bytes (its stream is typed `any` under Node's types)
      if (!(chunk.value instanceof Uint8Array)) throw new LlamaReplyError('the stream is not bytes');
      for (const ev of parser.push(decoder.decode(chunk.value, { stream: true }))) {
        if (ev.data === '[DONE]') {
          finished = true;
          return;
        }
        let j: unknown;
        try {
          j = JSON.parse(ev.data);
        } catch {
          continue;
        }
        // An event that is not a chunk is skipped, like one that is not JSON
        if (!isChunk(j)) continue;
        if (j.error) throw new LlamaStreamError(j.error);
        yield j;
      }
    }
  } finally {
    // Left early (a break, an error): stop the transfer. After [DONE] the server ends the response itself.
    if (!finished) reader.cancel().catch(() => {});
  }
}
