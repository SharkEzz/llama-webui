import { Hono } from 'hono';
import { expect, test } from 'vitest';
import { z } from 'zod';
import {
  accepts,
  allowTable,
  apiRoutes,
  body,
  type Env,
  errorResponse,
  guardMw,
  HttpError,
  id,
  json,
  object,
  query,
  shadowed,
} from './http';

test('errorResponse: an HttpError keeps its status and code, any other error is a 500', async () => {
  const r = errorResponse(new HttpError(409, 'A server is running', 'server-running'));
  expect(r.status).toBe(409);
  expect(await r.json()).toEqual({ error: 'A server is running', code: 'server-running' });
  expect(errorResponse(new HttpError(404, 'Profile not found')).status).toBe(404);
  expect(errorResponse(new Error('boom')).status).toBe(500);
});

/** A small API built with the helpers, the way createApi builds the real one. */
function things() {
  const allow = allowTable();
  const app = new Hono<Env>()
    .use(guardMw, allow.mw)
    .post('/api/things/import', (c) => c.text('ok'))
    .get('/api/things/:id', id('Thing'), (c) => c.json({ id: c.req.valid('param').id }))
    .post('/api/things', json(object), (c) => c.json(c.req.valid('json'), 201))
    .get('/api/stream', () => new Response('data: 1\n\n', { headers: { 'Content-Type': 'text/event-stream' } }))
    .get('/api/empty', (c) => c.body(null, 204));
  allow.load(apiRoutes(app));
  app.notFound((c) => c.json({ error: 'Unknown route' }, 404));
  app.onError((err) => errorResponse(err));
  return app;
}
const post = (body?: string, type?: string) =>
  ({ method: 'POST', body, headers: type ? { 'Content-Type': type } : {} }) as RequestInit;

test('a method a pattern lacks is a 405 with Allow, not the next matching pattern (#37)', async () => {
  const app = things();
  const r = await app.request('/api/things/import');
  expect(r.status).toBe(405);
  expect(r.headers.get('allow')).toBe('POST');
  expect(r.headers.get('content-type')).toBe('application/json');
  expect(await r.json()).toEqual({ error: 'Method not allowed (POST)' });
  expect((await app.request('/api/things/import', { method: 'HEAD' })).status).toBe(405);
  expect((await app.request('/api/things/import', { method: 'POST' })).status).toBe(200);
  expect((await app.request('/api/things/7', { method: 'DELETE' })).headers.get('allow')).toBe('GET');
  expect((await app.request('/api/things/7', { method: 'HEAD' })).status).toBe(200);
  const unknown = await app.request('/api/nothing');
  expect(unknown.status).toBe(404);
  expect(await unknown.json()).toEqual({ error: 'Unknown route' });
});

test('an empty segment does not match a :param: a trailing slash stays an unknown route', async () => {
  const app = things();
  for (const [path, method] of [
    ['/api/things/', 'PATCH'],
    ['/api/things/', 'GET'],
    ['/api/things//import', 'POST'],
  ]) {
    const r = await app.request(path as string, { method });
    expect([path, method, r.status]).toEqual([path, method, 404]);
  }
});

test('id() is a 404 for anything but a positive integer', async () => {
  const app = things();
  for (const bad of ['x', '0', '-1', '1.5'])
    expect(await (await app.request(`/api/things/${bad}`)).json()).toEqual({ error: 'Thing not found' });
  expect(await (await app.request('/api/things/12')).json()).toEqual({ id: 12 });
});

test('json(object): Invalid JSON, then JSON object expected', async () => {
  const app = things();
  const error = async (init: RequestInit) => {
    const r = await app.request('/api/things', init);
    return [r.status, ((await r.json()) as { error: string }).error];
  };
  expect(await error(post())).toEqual([400, 'Invalid JSON']);
  expect(await error(post('', 'application/json'))).toEqual([400, 'Invalid JSON']);
  expect(await error(post('{', 'application/json'))).toEqual([400, 'Invalid JSON']);
  expect(await error(post('[1]', 'application/json'))).toEqual([400, 'JSON object expected']);
  // A JSON media type outside Hono's own list: parsed all the same.
  const seq = await app.request('/api/things', post('{"a":1}', 'application/json-seq'));
  expect([seq.status, await seq.json()]).toEqual([201, { a: 1 }]);
});

test('a reply keeps the content type its handler gave it', async () => {
  const app = things();
  expect((await app.request('/api/things/1')).headers.get('content-type')).toBe('application/json');
  expect((await app.request('/api/stream')).headers.get('content-type')).toBe('text/event-stream');
  const empty = await app.request('/api/empty');
  expect([empty.status, empty.headers.get('content-type')]).toEqual([204, null]);
});

test('a static path registered after a parameter that shadows it is reported (#37)', () => {
  expect(
    shadowed([
      { method: 'GET', path: '/api/a/:id' },
      { method: 'GET', path: '/api/a/b' },
    ]),
  ).toEqual(['GET /api/a/b after /api/a/:id']);
  expect(
    shadowed([
      { method: 'GET', path: '/api/a/b' },
      { method: 'GET', path: '/api/a/:id' },
    ]),
  ).toEqual([]);
  expect(
    shadowed([
      { method: 'POST', path: '/api/a/:id' },
      { method: 'GET', path: '/api/a/b' },
    ]),
  ).toEqual([]);
});

test('body() validates a JSON object with zod: Invalid JSON, JSON object expected, then the schema', async () => {
  const Thing = z.strictObject({ name: z.string().min(1) });
  const app = new Hono<Env>().post('/api/object', body(Thing), (c) => c.json(c.req.valid('json'), 201));
  app.onError((err) => errorResponse(err));
  const reply = async (path: string, init: RequestInit) => {
    const r = await app.request(path, init);
    return [r.status, await r.json()];
  };
  expect(await reply('/api/object', post())).toEqual([400, { error: 'Invalid JSON' }]);
  expect(await reply('/api/object', post('{', 'application/json'))).toEqual([400, { error: 'Invalid JSON' }]);
  expect(await reply('/api/object', post('[1]', 'application/json'))).toEqual([400, { error: 'JSON object expected' }]);
  const [, bad] = await reply('/api/object', post('{"name":""}', 'application/json; charset=utf-8'));
  expect((bad as { error: string; issues: unknown[] }).error).toBe(
    'Invalid data: Too small: expected string to have >=1 characters (name)',
  );
  expect((bad as { issues: unknown[] }).issues).toHaveLength(1);
  expect(await reply('/api/object', post('{"name":"a"}', 'application/json'))).toEqual([201, { name: 'a' }]);
  // A media type outside Hono's JSON list is not read (zValidator would see `{}`).
  expect(await reply('/api/object', post('{"name":"a"}', 'application/json-seq'))).toEqual([
    400,
    { error: 'Invalid JSON' },
  ]);
});

test('query() gives the handler the declared keys, decoded as searchParams, and refuses nothing', async () => {
  const app = new Hono<Env>().get('/api/q', query('path', 'n'), (c) => c.json(c.req.valid('query')));
  const r = await app.request('/api/q?path=a+b%2Bc%23%C3%A9&n=1&n=2&other=x');
  expect(r.status).toBe(200);
  expect(await r.json()).toEqual({ path: 'a b+c#é', n: '1' });
  const none = await app.request('/api/q');
  expect(none.status).toBe(200);
  expect(await none.json()).toEqual({});
});

test('accepts() types the body for the client and reads nothing: the handler still decides (409 before 400)', async () => {
  const app = new Hono<Env>().post('/api/a', accepts<{ n: number }>(), async (c) => {
    if (c.req.header('x-busy')) throw new HttpError(409, 'busy');
    return c.json(object(await c.req.json()));
  });
  app.onError((err) => errorResponse(err));
  const post = (body: string, busy = false) =>
    app.request('/api/a', {
      method: 'POST',
      body,
      headers: { 'content-type': 'application/json', ...(busy ? { 'x-busy': '1' } : {}) },
    });
  expect((await post('{nope', true)).status).toBe(409);
  expect(await (await post('{nope')).json()).toEqual({ error: 'Invalid JSON' });
  expect(await (await post('{"n":2}')).json()).toEqual({ n: 2 });
});
