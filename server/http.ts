import { zValidator } from '@hono/zod-validator';
import type { BunRequest, Server } from 'bun';
import type { Hono, MiddlewareHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { validator } from 'hono/validator';
import { ZodError, type z } from 'zod';
import { guard } from './security';

/** What every API route sees: `c.env.server` is Bun's server (`api.fetch(req, { server })`), absent in tests. */
export type Env = { Bindings: { server?: Server<undefined> } };

/** The methods an API route can define, in the order of `Allow`. */
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

export class HttpError extends Error {
  override name = 'HttpError';
  constructor(
    readonly status: number,
    message: string,
    /** Machine-readable reason (e.g. “server-running”), returned in the JSON body. */
    readonly code?: string,
  ) {
    super(message);
  }
}

export const notFound = (what: string) => new HttpError(404, `${what} not found`);

/**
 * An `HttpError`, recognized by its shape rather than `instanceof`: the bench gate lives on `globalThis` and survives
 * `bun --hot`, so it throws the class of the first `server/http.ts`, not the current one (#34).
 */
export function isHttpError(err: unknown): err is HttpError {
  return err instanceof Error && err.name === 'HttpError' && typeof (err as HttpError).status === 'number';
}

export function errorResponse(err: unknown): Response {
  if (isHttpError(err))
    return Response.json(err.code ? { error: err.message, code: err.code } : { error: err.message }, {
      status: err.status,
    });
  if (err instanceof ZodError) {
    const first = err.issues[0];
    const where = first && first.path.length > 0 ? ` (${first.path.join('.')})` : '';
    return Response.json(
      { error: `Invalid data: ${first?.message ?? '?'}${where}`, issues: err.issues },
      { status: 400 },
    );
  }
  // Hono's json validator parses a JSON media type itself: its error says what req.json()'s SyntaxError says.
  if (err instanceof SyntaxError || (err instanceof HTTPException && err.message === 'Malformed JSON in request body'))
    return Response.json({ error: 'Invalid JSON' }, { status: 400 });
  console.error(err);
  return Response.json({ error: 'Internal error' }, { status: 500 });
}

export type Handler = (
  req: BunRequest<string>,
  server: Server<undefined>,
) => Response | undefined | Promise<Response | undefined>;

/** Applies the guard (host, origin, JSON) then the handler; any exception becomes a JSON response. */
export function guarded(handler: Handler): Handler {
  return async (req, server) => {
    const refused = guard(req);
    if (refused) return refused;
    try {
      return await handler(req, server);
    } catch (err) {
      return errorResponse(err);
    }
  };
}

/** Positive integer route parameter (`:id`), otherwise 404. */
export function idParam(req: BunRequest<string>, what: string): number {
  const raw = (req.params as Record<string, string>).id;
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) throw notFound(what);
  return id;
}

/** A JSON object, otherwise 400. */
export function object(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body))
    throw new HttpError(400, 'JSON object expected');
  return body as Record<string, unknown>;
}

/** JSON object body, otherwise 400. */
export async function jsonObject(req: Request): Promise<Record<string, unknown>> {
  return object(await req.json());
}

/** The guard of `server/security.ts` (host, origin, JSON) ahead of every API route. */
export const guardMw: MiddlewareHandler = async (c, next) => {
  const refused = guard(c.req.raw);
  if (refused) return refused;
  await next();
};

/**
 * `c.json()` says `application/json`; the API has always said `application/json;charset=utf-8` (Bun's
 * `Response.json`). Only that exact value is rewritten: a route that sets its own type keeps it.
 */
export const jsonCharset: MiddlewareHandler = async (c, next) => {
  await next();
  if (c.res.headers.get('content-type') === 'application/json')
    c.res.headers.set('content-type', 'application/json;charset=utf-8');
};

/** Positive integer `:id`, otherwise 404 (before any body check: 404 beats 400). */
export const id = (what: string) =>
  validator('param', (p: Record<string, string>) => {
    const n = Number(p.id);
    if (!Number.isInteger(n) || n <= 0) throw notFound(what);
    return { id: n };
  });

/**
 * JSON body passed through `check`. The body is read with `c.req.json()` whatever the media type, like `req.json()`
 * before (Hono's validator alone gives `{}` to a type outside its list); the guard has already refused a non-JSON one.
 */
export const json = <T>(check: (body: unknown) => T) =>
  validator('json', async (_value, c) => check(await c.req.json()));

/** Hono's test for a JSON media type (`hono/validator`): only those bodies reach a zod validator. */
const JSON_MEDIA = /^application\/([\w.-]+\+)?json$/i;
const isJsonMedia = (type: string | undefined) => JSON_MEDIA.test((type ?? '').split(';')[0]?.trim() ?? '');

/**
 * JSON body validated by `schema` (`@hono/zod-validator`), with the messages of `Schema.parse(await jsonObject(req))`:
 * a body that is not a JSON media type, or not JSON, is `Invalid JSON`; with `object`, a non-object is `JSON object
 * expected` before any schema message; otherwise the `ZodError` (→ `Invalid data: … (path)` + `issues`).
 */
export const body = <S extends z.ZodType>(schema: S, o: { object?: boolean } = {}) =>
  zValidator('json', schema, (r, c) => {
    if (!isJsonMedia(c.req.header('content-type'))) throw new HttpError(400, 'Invalid JSON');
    if (r.success) return;
    if (o.object) object(r.data);
    throw r.error;
  });

/** For `json()`: the body as sent, when the handler (or its repo) validates it after a lookup or a 409. */
export const passthrough = (body: unknown): unknown => body;

export interface RouteEntry {
  method: string;
  path: string;
}

/** The routes of a Hono app, middleware left out, in registration order. */
export const apiRoutes = (app: Hono<Env>): RouteEntry[] =>
  // biome-ignore lint/suspicious/noExplicitAny: any Hono schema; only `routes` is read.
  (app as Hono<any>).routes.filter((r) => r.method !== 'ALL').map(({ method, path }) => ({ method, path }));

const segments = (path: string) => path.split('/').slice(1);
const isParam = (segment: string) => segment.startsWith(':');

function matches(pattern: string, path: string): boolean {
  const p = segments(pattern);
  const s = segments(path);
  return p.length === s.length && p.every((seg, i) => isParam(seg) || seg === s[i]);
}

/** Negative when `a` is more specific: at the first segment where they differ in kind, static beats `:param`. */
function specificity(a: string, b: string): number {
  const x = segments(a);
  const y = segments(b);
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const d = Number(isParam(x[i] as string)) - Number(isParam(y[i] as string));
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * Hono matches in registration order: a static path registered after a `:param` pattern of the same method that
 * matches it is never reached (`GET /api/profiles/export` behind `/api/profiles/:id`). Lists those mistakes.
 */
export function shadowed(routes: RouteEntry[]): string[] {
  const out: string[] = [];
  routes.forEach((later, j) => {
    const first = routes
      .slice(0, j)
      .find(
        (r) =>
          r.method === later.method &&
          r.path !== later.path &&
          matches(r.path, later.path) &&
          specificity(r.path, later.path) > 0,
      );
    if (first) out.push(`${later.method} ${later.path} after ${first.path}`);
  });
  return out;
}

/**
 * 405 with `Allow` for a method the most specific matching pattern lacks (HEAD counts as GET), as Bun's router did
 * with `withMethodNotAllowed`: `GET /api/profiles/import` (POST only) must not fall to `/api/profiles/:id` (#37). No
 * matching pattern: on to `notFound`. `load` takes the app's routes once they are all registered.
 */
export function allowTable() {
  let byPath = new Map<string, Set<string>>();
  const mw: MiddlewareHandler = async (c, next) => {
    const method = c.req.method === 'HEAD' ? 'GET' : c.req.method;
    if (!(METHODS as readonly string[]).includes(method)) return next();
    let best: string | undefined;
    for (const pattern of byPath.keys())
      if (matches(pattern, c.req.path) && (best === undefined || specificity(pattern, best) < 0)) best = pattern;
    const methods = best === undefined ? undefined : byPath.get(best);
    if (methods === undefined || methods.has(method)) return next();
    const allow = METHODS.filter((m) => methods.has(m)).join(', ');
    return Response.json({ error: `Method not allowed (${allow})` }, { status: 405, headers: { Allow: allow } });
  };
  const load = (routes: RouteEntry[]) => {
    byPath = new Map();
    for (const r of routes) {
      const set = byPath.get(r.path) ?? new Set<string>();
      set.add(r.method);
      byPath.set(r.path, set);
    }
  };
  return { mw, load };
}

const isMethodMap = (v: unknown): v is Partial<Record<(typeof METHODS)[number], Handler>> =>
  typeof v === 'object' &&
  v !== null &&
  !(v instanceof Response) &&
  Object.keys(v).length > 0 &&
  Object.keys(v).every((k) => (METHODS as readonly string[]).includes(k));

/**
 * Gives every `/api/…` route defined by methods a `405` (with `Allow`) for the methods it lacks. Without it, Bun goes
 * on to the next matching route: `GET /api/profiles/import` (POST only) reached `/api/profiles/:id`.
 */
export function withMethodNotAllowed<T extends Record<string, unknown>>(routes: T): T {
  const out: Record<string, unknown> = { ...routes };
  for (const [path, value] of Object.entries(routes)) {
    if (!path.startsWith('/api/') || !isMethodMap(value)) continue;
    const allow = METHODS.filter((m) => m in value).join(', ');
    const refuse = guarded(() =>
      Response.json({ error: `Method not allowed (${allow})` }, { status: 405, headers: { Allow: allow } }),
    );
    const full: Record<string, Handler> = { ...value } as Record<string, Handler>;
    for (const m of METHODS) full[m] ??= refuse;
    out[path] = full;
  }
  return out as T;
}
