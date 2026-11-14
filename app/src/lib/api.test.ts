import { Schema } from 'effect';
import { HttpApi, HttpApiEndpoint, HttpApiGroup } from 'effect/http-api';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { errorTag, makeCall } from './api';

class TestNotFound extends Schema.TaggedError<TestNotFound>()(
  'TestNotFound',
  { message: Schema.String },
  { httpApiStatus: 404 },
) {}

const Item = Schema.Struct({ id: Schema.Int, name: Schema.String });

class TestApi extends HttpApi.make('test').add(
  HttpApiGroup.make('t').add(
    HttpApiEndpoint.get('get', '/t/:id', {
      params: { id: Schema.NumberFromString },
      query: { q: Schema.optional(Schema.String) },
      success: Item,
      error: TestNotFound,
    }),
    HttpApiEndpoint.post('create', '/t', { payload: Item, success: Item }),
  ),
) {}

// The browser resolves the client's relative URLs against the page; Vitest's node environment has no page.
beforeEach(() => {
  vi.stubGlobal('location', new URL('http://llama-webui.test/'));
});
afterEach(() => {
  vi.unstubAllGlobals();
});

interface Seen {
  url: string;
  init: RequestInit | undefined;
}

/** A `fetch` that answers `reply` (or rejects with it) and records what it was given. */
function stub(reply: (seen: Seen) => Promise<Response>) {
  const seen: Seen[] = [];
  const fetchImpl = ((input: RequestInfo | URL, init?: RequestInit) => {
    const s = { url: String(input), init };
    seen.push(s);
    return reply(s);
  }) as typeof fetch;
  return { call: makeCall(TestApi, fetchImpl), seen };
}

const json = (status: number, body: unknown) => () =>
  Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));

test('call() resolves with the decoded reply of the endpoint', async () => {
  const { call } = stub(json(200, { id: 7, name: 'seven' }));
  expect(await call((api) => api.t.get({ params: { id: 7 }, query: {} }))).toEqual({ id: 7, name: 'seven' });
});

test('call() fills in the path, the query and the JSON payload', async () => {
  const { call, seen } = stub(json(200, { id: 7, name: 'seven' }));
  await call((api) => api.t.get({ params: { id: 7 }, query: { q: 'a' } }));
  await call((api) => api.t.create({ payload: { id: 7, name: 'seven' } }));
  const [get, post] = seen;
  expect(new URL(get?.url ?? '').pathname + new URL(get?.url ?? '').search).toBe('/t/7?q=a');
  expect(get?.init?.method).toBe('GET');
  expect(new URL(post?.url ?? '').pathname).toBe('/t');
  expect(post?.init?.method).toBe('POST');
  expect(new Headers(post?.init?.headers).get('content-type')).toBe('application/json');
  expect(JSON.parse(new TextDecoder().decode(post?.init?.body as Uint8Array))).toEqual({ id: 7, name: 'seven' });
});

test('call() rejects with the tagged error of the endpoint', async () => {
  const { call } = stub(json(404, { _tag: 'TestNotFound', message: 'No item 7' }));
  const error = await call((api) => api.t.get({ params: { id: 7 }, query: {} })).catch((e: unknown) => e);
  expect(errorTag(error)).toBe('TestNotFound');
  expect((error as Error).message).toBe('No item 7');
});

test('call() rejects with ApiUnreachable when fetch rejects', async () => {
  const { call } = stub(() => Promise.reject(new TypeError('fetch failed')));
  const error = await call((api) => api.t.get({ params: { id: 7 }, query: {} })).catch((e: unknown) => e);
  expect(errorTag(error)).toBe('ApiUnreachable');
  expect((error as Error).message).toBe('llama-webui server unreachable');
});

test('a payload the client refuses to send rejects as the RequestInvalid the server would answer', async () => {
  class NamedApi extends HttpApi.make('named').add(
    HttpApiGroup.make('n').add(
      HttpApiEndpoint.post('create', '/n', {
        payload: Schema.Struct({ name: Schema.String.check(Schema.isMinLength(1, { message: 'cannot be empty' })) }),
      }),
    ),
  ) {}
  const fetchImpl = vi.fn<typeof fetch>();
  const call = makeCall(NamedApi, fetchImpl);
  const error = await call((api) => api.n.create({ payload: { name: '' } })).catch((e: unknown) => e);
  expect(errorTag(error)).toBe('RequestInvalid');
  expect(error).toMatchObject({
    message: 'Invalid data: cannot be empty (name)',
    issues: [{ path: ['name'], message: 'cannot be empty' }],
  });
  expect(fetchImpl).not.toHaveBeenCalled();
});

test('call() passes its signal: an abort reaches fetch and rejects the call', async () => {
  const { call, seen } = stub(
    ({ init }) =>
      new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal?.reason))),
  );
  const controller = new AbortController();
  const pending = call((api) => api.t.get({ params: { id: 7 }, query: {} }), { signal: controller.signal });
  await vi.waitFor(() => expect(seen).toHaveLength(1));
  controller.abort();
  await expect(pending).rejects.toBeDefined();
  expect(seen[0]?.init?.signal?.aborted).toBe(true);
});
