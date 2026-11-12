import type { AppType } from '@llama-webui/server/api';
import { type ClientResponse, hc } from 'hono/client';
import type { SuccessStatusCode } from 'hono/utils/http-status';

export interface ApiIssue {
  path: (string | number)[];
  message: string;
}

export class ApiError extends Error {
  readonly status: number;
  /** Zod details returned by the API on a 400 (field by field). */
  readonly issues: ApiIssue[];
  /** Reason returned by the API for some refusals (e.g. “server-running”). */
  readonly code: string | null;
  constructor(status: number, message: string, issues: ApiIssue[] = [], code: string | null = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.issues = issues;
    this.code = code;
  }
}

/** The API's typed client (`hc`), on the server's route types; `fetch` is replaced in tests. */
export const makeClient = (f?: typeof fetch) => hc<AppType>('/', f ? { fetch: f } : {}).api;
export const client = makeClient();

/** The `:id` of a route, as the client takes it. */
export const byId = (id: number) => ({ param: { id: String(id) } });

/** What a 2xx reply of `R` holds: its JSON output, `undefined` for a 204. */
export type Ok<R> =
  R extends ClientResponse<infer T, infer S, infer _F>
    ? S extends SuccessStatusCode
      ? S extends 204
        ? undefined
        : T
      : never
    : never;

/**
 * Awaits a call of `client` (`call(client.profiles.$get())`) and returns its body; throws `ApiError` if the response
 * is not 2xx (its `error`, `issues` and `code`), or if the server cannot be reached.
 */
export async function call<R extends ClientResponse<unknown, number, string>>(req: Promise<R>): Promise<Ok<R>> {
  let res: ClientResponse<unknown, number, string>;
  try {
    res = await req;
  } catch {
    throw new ApiError(0, 'llama-webui server unreachable');
  }
  const text = await res.text();
  let body: unknown;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  if (!res.ok) throw apiError(res.status, body);
  // The one place the body meets its type: the server's route declares it (`c.json(…)`).
  return body as Ok<R>;
}

/** JSON call to /api; throws ApiError if the response is not 2xx. */
export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body !== undefined && !headers.has('content-type')) headers.set('content-type', 'application/json');
  let res: Response;
  try {
    res = await fetch(`/api${path}`, { ...init, headers });
  } catch {
    throw new ApiError(0, 'llama-webui server unreachable');
  }
  const text = await res.text();
  let body: unknown;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  if (!res.ok) throw apiError(res.status, body);
  return body as T;
}

/** The `ApiError` of an error response: its `error` message, `issues` (validation) and `code`, when present. */
export function apiError(status: number, body: unknown): ApiError {
  const o = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
  const message = typeof o.error === 'string' ? o.error : `HTTP error ${status}`;
  const issues = Array.isArray(o.issues) ? (o.issues as ApiIssue[]) : [];
  const code = typeof o.code === 'string' ? o.code : null;
  return new ApiError(status, message, issues, code);
}

export interface Health {
  ok: boolean;
  version: string;
  uptimeMs: number;
}

export const getHealth = () => call(client.health.$get());
