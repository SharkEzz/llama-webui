import { HF_REPO_RE, type HfFile, type HfSearchHit, type HfStatus } from '@llama-webui/shared';
import { HttpError } from '../http';
import { type Env, type HfToken, hfEndpoint, resolveHfToken } from './token';

export interface HfClientDeps {
  fetch?: typeof fetch;
  env?: Env;
  home?: string;
  /** Timeout of an API call (10 s). */
  timeoutMs?: number;
}

export interface RepoFiles {
  id: string;
  sha: string;
  gated: boolean;
  files: HfFile[];
}

const USER_AGENT = 'llama-webui';

/**
 * A Hugging Face error response as an HttpError with a `code`: the `X-Error-Code` header first (a missing or
 * private repo answers 401 RepoNotFound without a token), then the status.
 */
export function hfHttpError(res: Response, o: { repo?: string; hasToken: boolean }): HttpError {
  const code = res.headers.get('x-error-code');
  const what = o.repo ?? 'Hugging Face resource';
  const login = o.hasToken ? '' : ' (set HF_TOKEN or run `hf auth login`)';
  if (code === 'GatedRepo' || res.status === 403)
    return new HttpError(403, `${what} is gated: accept its license on Hugging Face${login}`, 'hf-gated');
  if (code === 'RepoNotFound' || code === 'RevisionNotFound' || code === 'EntryNotFound' || res.status === 404)
    return new HttpError(404, `${what} not found on Hugging Face (or private${login})`, 'hf-not-found');
  if (res.status === 401) return new HttpError(401, 'Hugging Face rejected the token', 'hf-unauthorized');
  if (res.status === 429)
    return new HttpError(429, 'Hugging Face rate limit reached, try again later', 'hf-rate-limited');
  const msg = res.headers.get('x-error-message');
  return new HttpError(502, `Hugging Face error ${res.status}${msg ? `: ${msg}` : ''}`, 'hf-unreachable');
}

export const unreachable = (e: unknown) =>
  new HttpError(502, `Hugging Face unreachable: ${(e as Error).message}`, 'hf-unreachable');

/** Hugging Face Hub API: search, repository files, account of the token. */
export class HfClient {
  private readonly fetch: typeof fetch;
  private readonly env: Env;
  private readonly home: string | undefined;
  private readonly timeoutMs: number;
  private readonly whoami = new Map<string, Promise<{ user: string | null; invalid: boolean }>>();

  constructor(deps: HfClientDeps = {}) {
    this.fetch = deps.fetch ?? fetch;
    this.env = deps.env ?? process.env;
    this.home = deps.home;
    this.timeoutMs = deps.timeoutMs ?? 10_000;
  }

  get endpoint(): string {
    return hfEndpoint(this.env);
  }

  auth(): Promise<HfToken> {
    return resolveHfToken(this.env, this.home);
  }

  /** Request headers: user agent, and the token if there is one. */
  headers(token: string | null, extra: Record<string, string> = {}): Record<string, string> {
    return { 'user-agent': USER_AGENT, ...(token ? { authorization: `Bearer ${token}` } : {}), ...extra };
  }

  /** `signal`: the request of the client (a closed sheet, a new keystroke): the Hub call is dropped with it. */
  private async api<T>(path: string, o: { repo?: string; signal?: AbortSignal } = {}): Promise<T> {
    const { token } = await this.auth();
    const timeout = AbortSignal.timeout(this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetch(`${this.endpoint}${path}`, {
        headers: this.headers(token),
        signal: o.signal ? AbortSignal.any([timeout, o.signal]) : timeout,
      });
    } catch (e) {
      throw unreachable(e);
    }
    if (!res.ok) throw hfHttpError(res, { repo: o.repo, hasToken: token !== null });
    try {
      return (await res.json()) as T;
    } catch (e) {
      // A proxy or captive portal answering 200 with an HTML page: not the client's JSON (400).
      if (o.signal?.aborted) throw unreachable(e);
      throw new HttpError(502, `Hugging Face sent an invalid response (${path.split('?')[0]})`, 'hf-unreachable');
    }
  }

  async status(): Promise<HfStatus> {
    const { token, source } = await this.auth();
    const base = { token: source, endpoint: this.endpoint };
    if (!token) return { ...base, user: null, tokenInvalid: false };
    let who = this.whoami.get(token);
    if (!who) {
      who = this.api<{ name?: string }>('/api/whoami-v2').then(
        (r) => ({ user: r.name ?? null, invalid: false }),
        (e: unknown) => {
          // Network failure: not cached (retried next time); a rejected token is.
          if (!(e instanceof HttpError && e.code === 'hf-unauthorized')) this.whoami.delete(token);
          return { user: null, invalid: e instanceof HttpError && e.code === 'hf-unauthorized' };
        },
      );
      this.whoami.set(token, who);
    }
    const { user, invalid } = await who;
    return { ...base, user, tokenInvalid: invalid };
  }

  /** GGUF repositories matching `q`, most downloaded first. */
  async search(q: string, o: { limit?: number; signal?: AbortSignal } = {}): Promise<HfSearchHit[]> {
    const params = new URLSearchParams({ search: q, filter: 'gguf', sort: 'downloads', direction: '-1' });
    params.set('limit', String(o.limit ?? 30));
    for (const f of ['downloads', 'likes', 'gated', 'lastModified']) params.append('expand[]', f);
    const rows = await this.api<
      { id: string; downloads?: number; likes?: number; gated?: boolean | string; lastModified?: string }[]
    >(`/api/models?${params}`, { signal: o.signal });
    return rows.map((r) => ({
      id: r.id,
      downloads: r.downloads ?? 0,
      likes: r.likes ?? 0,
      lastModified: r.lastModified ?? null,
      gated: r.gated !== undefined && r.gated !== false,
    }));
  }

  /** The files of a repository at `revision` (branch, tag or commit), with size and sha256, and the resolved commit. */
  async repoFiles(id: string, revision = 'main', signal?: AbortSignal): Promise<RepoFiles> {
    if (!HF_REPO_RE.test(id)) throw new HttpError(400, `Invalid repository id: ${id}`);
    const info = await this.api<{
      id: string;
      sha: string;
      gated?: boolean | string;
      siblings?: { rfilename: string; size?: number; lfs?: { sha256: string; size: number } }[];
    }>(`/api/models/${id}/revision/${encodeURIComponent(revision)}?blobs=true`, { repo: id, signal });
    return {
      id: info.id,
      sha: info.sha,
      gated: info.gated !== undefined && info.gated !== false,
      files: (info.siblings ?? []).map((s) => ({
        path: s.rfilename,
        size: s.lfs?.size ?? s.size ?? 0,
        sha256: s.lfs?.sha256 ?? null,
      })),
    };
  }
}
