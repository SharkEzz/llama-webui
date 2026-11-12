import { expect, test } from 'vitest';
import { ApiError, call, makeClient } from './api';

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
  return { client: makeClient(f), seen };
}
const json = (status: number, body: unknown): Reply => ({
  status,
  body: JSON.stringify(body),
  type: 'application/json',
});

test('call() returns the JSON body of a 2xx reply', async () => {
  const { client, seen } = fake(json(200, { ok: true, version: 'dev', uptimeMs: 5 }));
  expect(await call(client.health.$get())).toEqual({ ok: true, version: 'dev', uptimeMs: 5 });
  expect(seen[0]?.url).toBe('/api/health');
});

test('call() gives undefined for an empty 2xx reply (204)', async () => {
  const { client } = fake({ status: 204 });
  expect(await call(client.profiles[':id'].$delete({ param: { id: '1' } }))).toBeUndefined();
});

test('call() throws the ApiError of an error reply, with issues and code', async () => {
  const issues = [{ path: ['name'], message: 'cannot be empty' }];
  const bad = fake(json(400, { error: 'Invalid data: cannot be empty (name)', issues }));
  const e400 = await call(bad.client.health.$get()).catch((e: unknown) => e);
  expect(e400).toBeInstanceOf(ApiError);
  expect(e400).toMatchObject({ status: 400, message: 'Invalid data: cannot be empty (name)', issues, code: null });
  const busy = fake(json(409, { error: 'A server is running', code: 'server-running' }));
  await expect(call(busy.client.health.$get())).rejects.toMatchObject({ status: 409, code: 'server-running' });
});

test('call() falls back to the status for an error reply that is not JSON', async () => {
  const { client } = fake({ status: 500, body: 'Internal Server Error', type: 'text/plain' });
  await expect(call(client.health.$get())).rejects.toMatchObject({ status: 500, message: 'HTTP error 500' });
});

test('call() maps a fetch that rejects to an unreachable server', async () => {
  const { client } = fake(new TypeError('fetch failed'));
  await expect(call(client.health.$get())).rejects.toMatchObject({
    status: 0,
    message: 'llama-webui server unreachable',
  });
});

test('call() passes the request options (signal) through to fetch', async () => {
  const { client, seen } = fake(json(200, { ok: true, version: 'dev', uptimeMs: 0 }));
  const signal = new AbortController().signal;
  await call(client.health.$get(undefined, { init: { signal } }));
  expect(seen[0]?.init?.signal).toBe(signal);
});
