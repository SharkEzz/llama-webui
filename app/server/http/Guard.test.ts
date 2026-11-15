import { describe, expect, test } from 'vitest';
import { refusal } from './Guard.ts';

/**
 * A request as Node's HTTP server hands it over: the `Host` of `url`, lower-case header names, and for a body its
 * length, plus the `text/plain` type that `fetch` gives a string body.
 */
const req = (
  url: string,
  init: { readonly method?: string; readonly body?: string; readonly headers?: Record<string, string> } = {},
) => {
  const headers: Record<string, string | undefined> = { host: new URL(url).host };
  if (init.body !== undefined) {
    headers['content-type'] = 'text/plain;charset=UTF-8';
    headers['content-length'] = String(new TextEncoder().encode(init.body).length);
  }
  return { method: init.method ?? 'GET', headers: { ...headers, ...init.headers } };
};

describe('guard', () => {
  test('guard: localhost or IP host accepted, domain name rejected (DNS rebinding)', () => {
    expect(refusal(req('http://127.0.0.1:7860/api/health'))).toBeUndefined();
    expect(refusal(req('http://localhost:7860/api/health'))).toBeUndefined();
    expect(refusal(req('http://192.168.0.20:7860/api/health'))).toBeUndefined();
    expect(refusal(req('http://[::1]:7860/api/health'))).toBeUndefined();
    expect(refusal(req('http://evil.example:7860/api/health'))?.status).toBe(403);
  });

  test('guard: Origin from another site rejected, same origin accepted', () => {
    const h = (origin: string) => ({ headers: { origin } });
    expect(refusal(req('http://127.0.0.1:7860/ws', h('http://127.0.0.1:7860')))).toBeUndefined();
    expect(refusal(req('http://127.0.0.1:7860/ws', h('https://evil.example')))?.status).toBe(403);
    expect(refusal(req('http://127.0.0.1:7860/ws', h('http://localhost:7860')))?.status).toBe(403);
  });

  test('guard: write without JSON rejected (simple request CSRF)', () => {
    const body = '{"port":1}';
    expect(
      refusal(
        req('http://127.0.0.1:7860/api/settings', { method: 'PATCH', body, headers: { 'content-type': 'text/plain' } }),
      )?.status,
    ).toBe(415);
    expect(refusal(req('http://127.0.0.1:7860/api/settings', { method: 'POST', body }))?.status).toBe(415);
    expect(
      refusal(
        req('http://127.0.0.1:7860/api/settings', {
          method: 'PATCH',
          body,
          headers: { 'content-type': 'application/json; charset=utf-8' },
        }),
      ),
    ).toBeUndefined();
    expect(refusal(req('http://127.0.0.1:7860/api/server/stop', { method: 'POST' }))).toBeUndefined(); // no body
  });

  /** A write with no type: only its framing headers say whether it carries a body. */
  const streamed = (headers: Record<string, string>) =>
    req('http://127.0.0.1:7860/api/server/stop', { method: 'POST', headers });

  test('guard: the body is judged from content-length and transfer-encoding, not from the body stream', () => {
    // Body-less write over HTTP (`hc` without `json`): no length, no transfer-encoding.
    expect(refusal(streamed({}))).toBeUndefined();
    expect(refusal(streamed({ 'content-length': '0' }))).toBeUndefined();
    expect(refusal(streamed({ 'content-length': '2' }))?.status).toBe(415);
    expect(refusal(streamed({ 'transfer-encoding': 'chunked' }))?.status).toBe(415);
    expect(refusal(streamed({ 'content-length': '2', 'content-type': 'application/json' }))).toBeUndefined();
  });

  test('guard: a Host that is not an authority is a 400, not a crash (req.url is built from it)', () => {
    expect(refusal({ method: 'GET', headers: { host: 'a b' } })).toEqual({ status: 400, message: 'Invalid host' });
    expect(refusal({ method: 'GET', headers: {} })).toEqual({ status: 400, message: 'Invalid host' });
  });
});
