// The H3 helpers of `http.ts`, on small apps built the way the route files use them. Not ported from master's Hono
// version: `shadowed()` (the radix router matches a static path before a `:param`, whatever the order) and `accepts()`
// (a route file declares its body type with `export type Body`, which reads nothing).
import { createEventStream, defineHandler, HTTPError } from 'nitro/h3';
import { expect, test } from 'vitest';
import { z } from 'zod';
import {
  allowTable,
  appError,
  errorResponse,
  HttpError,
  idParam,
  noContent,
  object,
  queryOf,
  readBody,
  readJson,
  reply,
} from './http';
import { routeApp } from './testing/routes';

test('appError: h3’s own HTTPError keeps its status; a wrapped error answers as the original', async () => {
  expect(appError(new HTTPError({ status: 404, headers: { 'cache-control': 'no-store' } })).status).toBe(404);
  const wrapped = new Error('wrapped', { cause: new HttpError(409, 'A server is running', 'server-running') });
  const r = appError(wrapped);
  expect(r.status).toBe(409);
  expect(await r.json()).toEqual({ error: 'A server is running', code: 'server-running' });
  expect(appError(new HttpError(404, 'Profile not found')).status).toBe(404);
});

test('errorResponse: an HttpError keeps its status and code, any other error is a 500', async () => {
  const r = errorResponse(new HttpError(409, 'A server is running', 'server-running'));
  expect(r.status).toBe(409);
  expect(await r.json()).toEqual({ error: 'A server is running', code: 'server-running' });
  expect(errorResponse(new HttpError(404, 'Profile not found')).status).toBe(404);
  expect(errorResponse(new Error('boom')).status).toBe(500);
});

/** A small API built with the helpers, the way the route files and `middleware/01.guard.ts` build the real one. */
function things() {
  const app = routeApp([
    ['POST', '/api/things/import', defineHandler(() => new Response('ok'))],
    ['GET', '/api/things/:id', defineHandler((event) => reply({ id: idParam(event, 'Thing') }))],
    ['POST', '/api/things', defineHandler(async (event) => reply(await readJson(event, object), 201))],
    [
      'GET',
      '/api/stream',
      defineHandler(() => new Response('data: 1\n\n', { headers: { 'Content-Type': 'text/event-stream' } })),
    ],
    ['GET', '/api/empty', defineHandler(() => noContent())],
  ]);
  const allow = allowTable([
    { method: 'POST', path: '/api/things/import' },
    { method: 'GET', path: '/api/things/:id' },
    { method: 'POST', path: '/api/things' },
    { method: 'GET', path: '/api/stream' },
    { method: 'GET', path: '/api/empty' },
  ]);
  app.use((event) => allow(event.req.method, event.url.pathname));
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

test('idParam() is a 404 for anything but a positive integer', async () => {
  const app = things();
  for (const bad of ['x', '0', '-1', '1.5'])
    expect(await (await app.request(`/api/things/${bad}`)).json()).toEqual({ error: 'Thing not found' });
  expect(await (await app.request('/api/things/12')).json()).toEqual({ id: 12 });
});

test('readJson(object): Invalid JSON, then JSON object expected', async () => {
  const app = things();
  const error = async (init: RequestInit) => {
    const r = await app.request('/api/things', init);
    return [r.status, ((await r.json()) as { error: string }).error];
  };
  expect(await error(post())).toEqual([400, 'Invalid JSON']);
  expect(await error(post('', 'application/json'))).toEqual([400, 'Invalid JSON']);
  expect(await error(post('{', 'application/json'))).toEqual([400, 'Invalid JSON']);
  expect(await error(post('[1]', 'application/json'))).toEqual([400, 'JSON object expected']);
  // Any media type: the body is parsed all the same (the guard has already refused a non-JSON one).
  const seq = await app.request('/api/things', post('{"a":1}', 'application/json-seq'));
  expect([seq.status, await seq.json()]).toEqual([201, { a: 1 }]);
});

test('a reply keeps the content type its handler gave it', async () => {
  const app = things();
  expect((await app.request('/api/things/1')).headers.get('content-type')).toBe('application/json');
  expect((await app.request('/api/stream')).headers.get('content-type')).toBe('text/event-stream');
  const empty = await app.request('/api/empty');
  expect([empty.status, empty.headers.get('content-type')]).toEqual([204, null]);
  // h3's own event stream (the chat's SSE).
  const sse = routeApp([
    [
      'GET',
      '/api/sse',
      defineHandler((event) => {
        const stream = createEventStream(event);
        void stream.close();
        return stream.send();
      }),
    ],
  ]);
  expect((await sse.request('/api/sse')).headers.get('content-type')).toBe('text/event-stream');
});

test('readBody() validates a JSON object with zod: Invalid JSON, JSON object expected, then the schema', async () => {
  const Thing = z.strictObject({ name: z.string().min(1) });
  const app = routeApp([
    ['POST', '/api/object', defineHandler(async (event) => reply(await readBody(event, Thing), 201))],
  ]);
  const answer = async (path: string, init: RequestInit) => {
    const r = await app.request(path, init);
    return [r.status, await r.json()];
  };
  expect(await answer('/api/object', post())).toEqual([400, { error: 'Invalid JSON' }]);
  expect(await answer('/api/object', post('{', 'application/json'))).toEqual([400, { error: 'Invalid JSON' }]);
  expect(await answer('/api/object', post('[1]', 'application/json'))).toEqual([
    400,
    { error: 'JSON object expected' },
  ]);
  const [, bad] = await answer('/api/object', post('{"name":""}', 'application/json; charset=utf-8'));
  expect((bad as { error: string; issues: unknown[] }).error).toBe(
    'Invalid data: Too small: expected string to have >=1 characters (name)',
  );
  expect((bad as { issues: unknown[] }).issues).toHaveLength(1);
  expect(await answer('/api/object', post('{"name":"a"}', 'application/json'))).toEqual([201, { name: 'a' }]);
  // A media type that is not JSON is not read.
  expect(await answer('/api/object', post('{"name":"a"}', 'application/json-seq'))).toEqual([
    400,
    { error: 'Invalid JSON' },
  ]);
});

test('queryOf() gives the handler the declared keys, decoded as searchParams, and refuses nothing', async () => {
  const app = routeApp([['GET', '/api/q', defineHandler((event) => reply(queryOf(event, 'path', 'n')))]]);
  const r = await app.request('/api/q?path=a+b%2Bc%23%C3%A9&n=1&n=2&other=x');
  expect(r.status).toBe(200);
  expect(await r.json()).toEqual({ path: 'a b+c#é', n: '1' });
  const none = await app.request('/api/q');
  expect(none.status).toBe(200);
  expect(await none.json()).toEqual({});
});
