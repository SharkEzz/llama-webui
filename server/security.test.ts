import { expect, test } from 'bun:test';
import { guard } from './security';

const req = (url: string, init: RequestInit & { headers?: Record<string, string> } = {}) => new Request(url, init);

test('guard: localhost or IP host accepted, domain name rejected (DNS rebinding)', () => {
  expect(guard(req('http://127.0.0.1:7860/api/health'))).toBeUndefined();
  expect(guard(req('http://localhost:7860/api/health'))).toBeUndefined();
  expect(guard(req('http://192.168.0.20:7860/api/health'))).toBeUndefined();
  expect(guard(req('http://[::1]:7860/api/health'))).toBeUndefined();
  expect(guard(req('http://evil.example:7860/api/health'))?.status).toBe(403);
});

test('guard: Origin from another site rejected, same origin accepted', () => {
  const h = (origin: string) => ({ headers: { origin } });
  expect(guard(req('http://127.0.0.1:7860/ws', h('http://127.0.0.1:7860')))).toBeUndefined();
  expect(guard(req('http://127.0.0.1:7860/ws', h('https://evil.example')))?.status).toBe(403);
  expect(guard(req('http://127.0.0.1:7860/ws', h('http://localhost:7860')))?.status).toBe(403);
});

test('guard: write without JSON rejected (simple request CSRF)', () => {
  const body = '{"port":1}';
  expect(
    guard(
      req('http://127.0.0.1:7860/api/settings', { method: 'PATCH', body, headers: { 'content-type': 'text/plain' } }),
    )?.status,
  ).toBe(415);
  expect(guard(req('http://127.0.0.1:7860/api/settings', { method: 'POST', body }))?.status).toBe(415);
  expect(
    guard(
      req('http://127.0.0.1:7860/api/settings', {
        method: 'PATCH',
        body,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      }),
    ),
  ).toBeUndefined();
  expect(guard(req('http://127.0.0.1:7860/api/server/stop', { method: 'POST' }))).toBeUndefined(); // no body
});
