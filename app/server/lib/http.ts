import { type H3Event, HTTPError } from 'nitro/h3';
import { ZodError, type z } from 'zod';

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

/** The API's error body: `server/error.ts` answers every thrown error with it (h3 passes the original as `cause`). */
export function errorResponse(err: unknown): Response {
  if (err instanceof HttpError)
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
  // `req.json()` on an empty or malformed body.
  if (err instanceof SyntaxError) return Response.json({ error: 'Invalid JSON' }, { status: 400 });
  // h3's own errors (a status it chose: 404 of a route it does not know…).
  if (HTTPError.isError(err) && err.status < 500) return Response.json({ error: err.message }, { status: err.status });
  console.error(err);
  return Response.json({ error: 'Internal error' }, { status: 500 });
}

declare const JSON_BODY: unique symbol;

/**
 * A JSON response whose body is `T`, for the web's typed client (`server/api.gen.ts` reads `T` off each handler's
 * return type). The brand is a type only: at run time it is a plain `Response`.
 */
export type JsonResponse<T> = Response & { readonly [JSON_BODY]?: T };

/** `T` as JSON, `content-type: application/json` exactly (h3's own serialization adds `;charset=UTF-8`). */
export const reply = <T>(data: T, status = 200): JsonResponse<T> => Response.json(data, { status });

/** 204: the client's call gives `undefined`. */
export const noContent = (): JsonResponse<undefined> => new Response(null, { status: 204 });

/** A JSON download, indented for a person to read. */
export const attachment = <T>(filename: string, body: T): JsonResponse<T> =>
  new Response(`${JSON.stringify(body, null, 2)}\n`, {
    headers: {
      'content-type': 'application/json',
      'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
    },
  });

/** A JSON object, otherwise 400. */
export function object(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body))
    throw new HttpError(400, 'JSON object expected');
  return body as Record<string, unknown>;
}

/** For `readJson()`: the body as sent, when the handler (or its repo) validates it after a lookup or a 409. */
export const passthrough = (body: unknown): unknown => body;

/** Positive integer `:id` (`[id]` in the route's file name), otherwise 404: read it before the body (404 beats 400). */
export function idParam(event: H3Event, what: string): number {
  const n = Number(event.context.params?.id);
  if (!Number.isInteger(n) || n <= 0) throw notFound(what);
  return n;
}

export type QueryOf<K extends string> = { [k in K]?: string };

/**
 * The query keys a route reads: the first value of each key present, decoded by `URLSearchParams` (the decoding the
 * contract suite records). Refuses nothing: a missing key is the handler's call.
 */
export function queryOf<K extends string>(event: H3Event, ...keys: K[]): QueryOf<K> {
  const params = event.url.searchParams;
  const out: QueryOf<K> = {};
  for (const k of keys) {
    const v = params.get(k);
    if (v !== null) out[k] = v;
  }
  return out;
}

/**
 * JSON body passed through `check`, whatever the media type (the guard has already refused a non-JSON one). An empty
 * or malformed body throws `SyntaxError` → `Invalid JSON`.
 */
export async function readJson<T>(event: H3Event, check: (body: unknown) => T): Promise<T> {
  return check(await event.req.json());
}

/** A JSON media type (`application/json`, `application/x+json`): only those bodies reach a schema. */
const JSON_MEDIA = /^application\/([\w.-]+\+)?json$/i;
const isJsonMedia = (type: string | null) => JSON_MEDIA.test((type ?? '').split(';')[0]?.trim() ?? '');

/**
 * JSON object validated by `schema`: a body that is not a JSON media type, or not JSON, is `Invalid JSON`; a
 * non-object is `JSON object expected` before any schema message; otherwise the `ZodError` (→ `Invalid data: … (path)`
 * + `issues`).
 */
export async function readBody<S extends z.ZodType>(event: H3Event, schema: S): Promise<z.output<S>> {
  if (!isJsonMedia(event.req.headers.get('content-type'))) throw new HttpError(400, 'Invalid JSON');
  let data: unknown;
  try {
    data = await event.req.json();
  } catch {
    throw new HttpError(400, 'Invalid JSON');
  }
  const r = schema.safeParse(data);
  if (r.success) return r.data;
  object(data);
  throw r.error;
}

export interface RouteEntry {
  method: string;
  path: string;
}

const segments = (path: string) => path.split('/').slice(1);
const isParam = (segment: string) => segment.startsWith(':');

/** A `:param` never matches an empty segment (`/api/profiles/` is an unknown route, not a 405). */
const matchesSegments = (p: string[], s: string[]): boolean =>
  p.length === s.length && p.every((seg, i) => (isParam(seg) && s[i] !== '') || seg === s[i]);

/** Negative when `x` is more specific: at the first segment where they differ in kind, static beats `:param`. */
function specificitySegments(x: string[], y: string[]): number {
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const d = Number(isParam(x[i] as string)) - Number(isParam(y[i] as string));
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * 405 with `Allow` for a method the most specific matching pattern lacks (HEAD counts as GET), as the API always
 * answered (#37), and 404 `Unknown route` for an API path no pattern matches. Nitro cannot do either: its SPA renderer
 * answers every request no handler took (the spike's S0 probe).
 */
export function allowTable(routes: RouteEntry[]): (method: string, pathname: string) => Response | undefined {
  const byPath = new Map<string, Set<string>>();
  for (const r of routes) {
    const set = byPath.get(r.path) ?? new Set<string>();
    set.add(r.method);
    byPath.set(r.path, set);
  }
  // One entry per pattern, its segments split once: this runs on every API request.
  const patterns = [...byPath].map(([path, methods]) => ({ segments: segments(path), methods }));
  return (rawMethod, pathname) => {
    const method = rawMethod === 'HEAD' ? 'GET' : rawMethod;
    const path = segments(pathname);
    let best: (typeof patterns)[number] | undefined;
    for (const p of patterns)
      if (matchesSegments(p.segments, path) && (!best || specificitySegments(p.segments, best.segments) < 0)) best = p;
    if (!best) return Response.json({ error: 'Unknown route' }, { status: 404 });
    if (!(METHODS as readonly string[]).includes(method) || best.methods.has(method)) return undefined;
    const { methods } = best;
    const allow = METHODS.filter((m) => methods.has(m)).join(', ');
    return Response.json({ error: `Method not allowed (${allow})` }, { status: 405, headers: { Allow: allow } });
  };
}
