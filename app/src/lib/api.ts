import type { Api } from '../../server/api.gen';
import type { ParamsOf } from '../../server/lib/apiTypes';

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

/** A route of the API: `'GET /api/profiles/:id'` (`server/api.gen.ts`, generated from the file routes). */
export type ApiRoute = keyof Api;

type PathOf<K> = K extends `${string} ${infer P}` ? P : never;

/** What a call of `K` takes: `:id` params, the query, the JSON body, an abort signal. */
export type ApiOptions<K extends ApiRoute> = { signal?: AbortSignal } & (unknown extends ParamsOf<PathOf<K>>
  ? { params?: never }
  : { params: ParamsOf<PathOf<K>> }) &
  ([Api[K]['body']] extends [never] ? { body?: never } : { body: Api[K]['body'] }) &
  ([Api[K]['query']] extends [never] ? { query?: never } : { query?: Api[K]['query'] });

type IsUnion<T, U = T> = T extends unknown ? ([U] extends [T] ? false : true) : never;

/**
 * The options of `K`, optional when it needs none. A route that is not in `Api` leaves `K` the union of every route:
 * the options are then optional, so that `tsc` reports the route itself, not a missing argument.
 */
type Args<K extends ApiRoute> =
  true extends IsUnion<K>
    ? [options?: ApiOptions<K>]
    : object extends ApiOptions<K>
      ? [options?: ApiOptions<K>]
      : [options: ApiOptions<K>];

/** What a 2xx reply of `K` holds: its JSON body, `undefined` for a 204. */
export type ApiReply<K extends ApiRoute> = Api[K]['res'];

/** The request of `route`: method and path, `:id` filled in, query string, JSON body. */
function build(route: string, o: ApiOptions<ApiRoute> | undefined): [string, RequestInit] {
  const [method, template] = route.split(' ') as [string, string];
  const params = (o?.params ?? {}) as Record<string, unknown>;
  let url = template.replace(/:(\w+)/g, (_, k: string) => encodeURIComponent(String(params[k])));
  const query = new URLSearchParams();
  for (const [k, v] of Object.entries((o?.query ?? {}) as Record<string, string | undefined>))
    if (v !== undefined) query.set(k, v);
  if (query.size > 0) url += `?${query}`;
  const init: RequestInit = { method };
  if (o?.signal) init.signal = o.signal;
  if (o && 'body' in o) {
    init.body = JSON.stringify(o.body);
    init.headers = { 'content-type': 'application/json' };
  }
  return [url, init];
}

/** The API's client on `f` (`fetch` by default; replaced in tests). */
export function makeApi(f?: typeof fetch) {
  const fetchImpl = f ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));

  /** The raw response of a route (the chat's server-sent events). */
  const request = <K extends ApiRoute>(route: K, ...[o]: Args<K>): Promise<Response> =>
    fetchImpl(...build(route, o as ApiOptions<ApiRoute> | undefined));

  /**
   * Calls a route (`api('GET /api/profiles/:id', { params: { id } })`) and returns its body; throws `ApiError` if the
   * response is not 2xx (its `error`, `issues` and `code`), or if the server cannot be reached.
   */
  const api = async <K extends ApiRoute>(route: K, ...args: Args<K>): Promise<ApiReply<K>> => {
    let res: Response;
    try {
      res = await request(route, ...args);
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
    // The one place the body meets its type: the server's handler declares it (`reply<T>()`).
    return body as ApiReply<K>;
  };
  return { api, request };
}

export const { api, request } = makeApi();

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

export const getHealth = () => api('GET /api/health');
