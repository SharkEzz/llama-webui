import { expect, test } from 'vitest';
import { ApiError, makeApi } from './api';

type Reply = { status: number; body?: string; type?: string };

/** A client whose fetch answers `reply` and records what it was given. */
function fake(reply: Reply | Error) {
  const seen: { url: string; init: RequestInit | undefined }[] = [];
  const f = (async (url: string, init?: RequestInit) => {
    seen.push({ url, init });
    if (reply instanceof Error) throw reply;
    const headers = reply.type ? { 'content-type': reply.type } : undefined;
    return new Response(reply.body ?? null, { status: reply.status, headers });
  }) as typeof fetch;
  return { api: makeApi(f).api, seen };
}
const json = (status: number, body: unknown): Reply => ({
  status,
  body: JSON.stringify(body),
  type: 'application/json',
});

test('api() returns the JSON body of a 2xx reply', async () => {
  const { api, seen } = fake(json(200, { ok: true, version: 'dev', uptimeMs: 5 }));
  expect(await api('GET /api/health')).toEqual({ ok: true, version: 'dev', uptimeMs: 5 });
  expect(seen[0]?.url).toBe('/api/health');
});

test('api() gives undefined for an empty 2xx reply (204)', async () => {
  const { api } = fake({ status: 204 });
  expect(await api('DELETE /api/profiles/:id', { params: { id: 1 } })).toBeUndefined();
});

test('api() throws the ApiError of an error reply, with issues and code', async () => {
  const issues = [{ path: ['name'], message: 'cannot be empty' }];
  const bad = fake(json(400, { error: 'Invalid data: cannot be empty (name)', issues }));
  const e400 = await bad.api('GET /api/health').catch((e: unknown) => e);
  expect(e400).toBeInstanceOf(ApiError);
  expect(e400).toMatchObject({ status: 400, message: 'Invalid data: cannot be empty (name)', issues, code: null });
  const busy = fake(json(409, { error: 'A server is running', code: 'server-running' }));
  await expect(busy.api('GET /api/health')).rejects.toMatchObject({ status: 409, code: 'server-running' });
});

test('api() falls back to the status for an error reply that is not JSON', async () => {
  const { api } = fake({ status: 500, body: 'Internal Server Error', type: 'text/plain' });
  await expect(api('GET /api/health')).rejects.toMatchObject({ status: 500, message: 'HTTP error 500' });
});

test('api() maps a fetch that rejects to an unreachable server', async () => {
  const { api } = fake(new TypeError('fetch failed'));
  await expect(api('GET /api/health')).rejects.toMatchObject({
    status: 0,
    message: 'llama-webui server unreachable',
  });
});

test('api() passes the request options (signal) through to fetch', async () => {
  const { api, seen } = fake(json(200, { ok: true, version: 'dev', uptimeMs: 0 }));
  const signal = new AbortController().signal;
  await api('GET /api/health', { signal });
  expect(seen[0]?.init?.signal).toBe(signal);
});

test('api() fills in :id, the query and the JSON body', async () => {
  const { api, seen } = fake(json(200, {}));
  await api('PUT /api/profiles/:id', { params: { id: 7 }, body: { name: 'x' } });
  await api('GET /api/hf/repo', { query: { id: 'a/b c', revision: undefined } });
  expect(seen[0]).toMatchObject({ url: '/api/profiles/7', init: { method: 'PUT', body: '{"name":"x"}' } });
  expect(seen[0]?.init?.headers).toEqual({ 'content-type': 'application/json' });
  expect(seen[1]?.url).toBe('/api/hf/repo?id=a%2Fb+c');
});
