import { type IncomingHttpHeaders, type IncomingMessage, request } from 'node:http';
import { Readable } from 'node:stream';

/** Statuses whose response has no body (`new Response()` refuses one). */
const NULL_BODY = new Set([204, 205, 304]);

/** Node's headers as web `Headers`: a repeated one keeps each of its values. */
export function webHeaders(from: IncomingHttpHeaders): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(from))
    for (const v of Array.isArray(value) ? value : value === undefined ? [] : [value]) headers.append(name, v);
  return headers;
}

/**
 * `fetch` for the requests to llama-server that can stay silent for minutes (a long prompt being processed, a
 * non-streamed benchmark request). Node's own `fetch` gives up after 300 s without response headers, and after 300 s
 * between two chunks of the body; nothing in Node changes those limits. A `node:http` request has neither: the
 * caller's `signal` is the only timeout.
 *
 * Only what those requests need: plain `http:`, a string or bytes body, no redirect, no proxy (its own connection,
 * closed with the response). Errors as `fetch` reports them: `TypeError: fetch failed` with the `cause`, or the
 * signal's reason; a body cut short or aborted breaks its stream.
 */
export const llamaFetch: typeof fetch = (input, init = {}) =>
  new Promise<Response>((resolve, reject) => {
    if (input instanceof Request) throw new TypeError('llamaFetch: a URL is expected, not a Request');
    const { body } = init;
    if (body != null && typeof body !== 'string' && !(body instanceof Uint8Array))
      throw new TypeError('llamaFetch: a string or bytes body is expected');
    const signal = init.signal ?? undefined;
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const method = (init.method ?? 'GET').toUpperCase();
    const req = request(input, {
      method,
      headers: Object.fromEntries(new Headers(init.headers)),
      // Not the global agent: no pooled connection to find closed, and no proxy when the environment sets one.
      agent: false,
    });
    let response: IncomingMessage | undefined;
    const onAbort = () => {
      // The body's stream breaks with the reason, not with the "aborted" of a cut connection.
      response?.destroy(signal?.reason);
      req.destroy(signal?.reason);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    // The request ends with its response, or with its failure: nothing left to abort.
    req.once('close', () => signal?.removeEventListener('abort', onAbort));
    // `on`, not `once`: an 'error' without a listener is an uncaught exception, whenever it comes.
    req.on('error', (err) => reject(signal?.aborted ? signal.reason : new TypeError('fetch failed', { cause: err })));
    req.once('response', (res) => {
      response = res;
      // A connection cut during the body breaks its stream (`Readable.toWeb`); this keeps it from being uncaught too.
      res.on('error', () => {});
      const status = res.statusCode ?? 0;
      const empty = NULL_BODY.has(status) || method === 'HEAD';
      if (empty) res.resume();
      resolve(
        new Response(empty ? null : (Readable.toWeb(res) as ReadableStream<Uint8Array>), {
          status,
          statusText: res.statusMessage ?? '',
          headers: webHeaders(res.headers),
        }),
      );
    });
    req.end(body ?? undefined);
  });
