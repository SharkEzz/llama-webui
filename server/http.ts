import type { BunRequest, Server } from 'bun';
import { ZodError } from 'zod';
import { guard } from './security';

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
  if (err instanceof SyntaxError) return Response.json({ error: 'Invalid JSON' }, { status: 400 });
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

/** JSON object body, otherwise 400. */
export async function jsonObject(req: Request): Promise<Record<string, unknown>> {
  const body: unknown = await req.json();
  if (typeof body !== 'object' || body === null || Array.isArray(body))
    throw new HttpError(400, 'JSON object expected');
  return body as Record<string, unknown>;
}

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

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
