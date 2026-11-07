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
  if (!res.ok) {
    const message =
      typeof body === 'object' && body !== null && 'error' in body && typeof body.error === 'string'
        ? body.error
        : `HTTP error ${res.status}`;
    const issues =
      typeof body === 'object' && body !== null && 'issues' in body && Array.isArray(body.issues)
        ? (body.issues as ApiIssue[])
        : [];
    const code =
      typeof body === 'object' && body !== null && 'code' in body && typeof body.code === 'string' ? body.code : null;
    throw new ApiError(res.status, message, issues, code);
  }
  return body as T;
}

export interface Health {
  ok: boolean;
  version: string;
  uptimeMs: number;
}

export const getHealth = () => api<Health>('/health');
