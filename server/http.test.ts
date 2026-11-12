import { Hono } from 'hono';
import { expect, test } from 'vitest';
import { z } from 'zod';
import {
  allowTable,
  apiRoutes,
  body,
  type Env,
  errorResponse,
  guardMw,
  HttpError,
  id,
  json,
  jsonCharset,
  object,
  shadowed,
} from './http';

test('an HttpError from an older module (bun --hot) keeps its status and code (#34)', async () => {
  // What the bench gate throws after a reload: same name and fields, another class.
  class StaleHttpError extends Error {
    override name = 'HttpError';
    constructor(
      readonly status: number,
      message: string,
      readonly code?: string,
    ) {
      super(message);
    }
  }
  const r = errorResponse(new StaleHttpError(409, 'A server is running', 'server-running'));
  expect(r.status).toBe(409);
  expect(await r.json()).toEqual({ error: 'A server is running', code: 'server-running' });
  expect(errorResponse(new HttpError(404, 'Profile not found')).status).toBe(404);
  expect(errorResponse(new Error('boom')).status).toBe(500);
});

/** A small API built with the helpers, the way createApi builds the real one. */
function things() {
  const allow = allowTable();
  const app = new Hono<Env>()
    .use(jsonCharset, guardMw, allow.mw)
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
  expect(r.headers.get('content-type')).toBe('application/json;charset=utf-8');
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

test('json(object) keeps the messages of req.json() and jsonObject()', async () => {
  const app = things();
  const error = async (init: RequestInit) => {
    const r = await app.request('/api/things', init);
    return [r.status, ((await r.json()) as { error: string }).error];
  };
  expect(await error(post())).toEqual([400, 'Invalid JSON']);
  expect(await error(post('', 'application/json'))).toEqual([400, 'Invalid JSON']);
  expect(await error(post('{', 'application/json'))).toEqual([400, 'Invalid JSON']);
  expect(await error(post('[1]', 'application/json'))).toEqual([400, 'JSON object expected']);
  // A JSON media type outside Hono's own list: parsed all the same, as req.json() does.
  const seq = await app.request('/api/things', post('{"a":1}', 'application/json-seq'));
  expect([seq.status, await seq.json()]).toEqual([201, { a: 1 }]);
});

test('jsonCharset only rewrites a bare application/json', async () => {
  const app = things();
  expect((await app.request('/api/things/1')).headers.get('content-type')).toBe('application/json;charset=utf-8');
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

test('body() validates with zod and keeps the messages of Schema.parse(await jsonObject(req))', async () => {
  const Thing = z.strictObject({ name: z.string().min(1) });
  const app = new Hono<Env>()
    .post('/api/loose', body(Thing), (c) => c.json(c.req.valid('json'), 201))
    .post('/api/object', body(Thing, { object: true }), (c) => c.json(c.req.valid('json'), 201));
  app.onError((err) => errorResponse(err));
  const reply = async (path: string, init: RequestInit) => {
    const r = await app.request(path, init);
    return [r.status, await r.json()];
  };
  expect(await reply('/api/object', post())).toEqual([400, { error: 'Invalid JSON' }]);
  expect(await reply('/api/object', post('{', 'application/json'))).toEqual([400, { error: 'Invalid JSON' }]);
  expect(await reply('/api/object', post('[1]', 'application/json'))).toEqual([400, { error: 'JSON object expected' }]);
  const [status, loose] = await reply('/api/loose', post('[1]', 'application/json'));
  expect([status, (loose as { error: string }).error]).toEqual([
    400,
    'Invalid data: Invalid input: expected object, received array',
  ]);
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
