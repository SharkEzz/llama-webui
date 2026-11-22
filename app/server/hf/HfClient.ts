import {
  HF_COMMIT_RE,
  HF_REPO_RE,
  type HfFile,
  HfGated,
  HfNotFound,
  HfRateLimited,
  type HfSearchHit,
  type HfStatus,
  HfUnauthorized,
  HfUnreachable,
} from '@llama-webui/shared';
import {
  Array as Arr,
  Context,
  Deferred,
  Effect,
  type FileSystem,
  Layer,
  Metric,
  Option,
  Predicate,
  Schema,
  type Scope,
  String as Str,
  SynchronizedRef,
} from 'effect';
import { dual } from 'effect/Function';
import { type HttpClientError, HttpClientRequest, type HttpClientResponse, type UrlParams } from 'effect/http';
import { cacheLoad, cacheLookup, HfMetrics } from '../runtime/Metrics.ts';
import { HfHttp } from './HfHttp.ts';
import { hfEndpoint, hfToken, hubHeaders } from './token.ts';

/** What a call to the Hub may fail with. */
export type HubError = HfGated | HfNotFound | HfUnauthorized | HfRateLimited | HfUnreachable;

/** The files of a repository at a revision, with their size and sha256, and the commit it resolved to. */
export interface RepoFiles {
  readonly id: string;
  readonly sha: string;
  readonly gated: boolean;
  readonly files: ReadonlyArray<HfFile>;
}

/** How long a call to the Hub's API may take, its redirects followed and its body read. */
const API_TIMEOUT = '10 seconds';

/** How many redirects a call to the Hub's API follows (a renamed repository answers 307 to its new name). */
const MAX_REDIRECTS = 5;

const isRedirect = (status: number): boolean =>
  status === 301 || status === 302 || status === 303 || status === 307 || status === 308;

/** Where `location` (resolved against `from`) leads, when it stays on `origin`: the token never leaves it. */
const sameOrigin = (location: string | undefined, from: string, origin: string): Option.Option<string> =>
  Option.flatMap(Option.fromNullishOr(location), (to) =>
    Option.map(
      Option.filter(Option.fromNullishOr(URL.parse(to, from)), (url) => url.origin === origin),
      (url) => url.href,
    ),
  );

/**
 * The error of a Hub answer that is not a success: its `x-error-code` first (a private or missing repository answers
 * 401 `RepoNotFound` without a token), then its status. `repo` names what was asked for; without a token, the messages
 * say where to set one.
 */
export const hubError: {
  (options: {
    readonly repo?: string | undefined;
    readonly hasToken: boolean;
  }): (response: HttpClientResponse.HttpClientResponse) => HubError;
  (
    response: HttpClientResponse.HttpClientResponse,
    options: { readonly repo?: string | undefined; readonly hasToken: boolean },
  ): HubError;
} = dual(
  2,
  (
    response: HttpClientResponse.HttpClientResponse,
    options: { readonly repo?: string | undefined; readonly hasToken: boolean },
  ): HubError => {
    const code = response.headers['x-error-code'];
    const what = options.repo ?? 'Hugging Face resource';
    const login = options.hasToken ? '' : ' (set HF_TOKEN or run `hf auth login`)';
    if (code === 'GatedRepo' || response.status === 403) {
      return HfGated.make({ message: `${what} is gated: accept its license on Hugging Face${login}` });
    }
    if (code === 'RepoNotFound' || code === 'RevisionNotFound' || code === 'EntryNotFound' || response.status === 404) {
      return HfNotFound.make({ message: `${what} not found on Hugging Face (or private${login})` });
    }
    if (response.status === 401) return HfUnauthorized.make({ message: 'Hugging Face rejected the token' });
    if (response.status === 429) {
      return HfRateLimited.make({ message: 'Hugging Face rate limit reached, try again later' });
    }
    const detail = Option.match(
      Option.filter(Option.fromNullishOr(response.headers['x-error-message']), Str.isNonEmpty),
      {
        onNone: () => '',
        onSome: (message) => `: ${message}`,
      },
    );
    return HfUnreachable.make({ message: `Hugging Face error ${response.status}${detail}` });
  },
);

/**
 * Why a request got no answer: the description of its failure, else the message of its cause (`connect ECONNREFUSED
 * …`), else the cause's code (a connection tried on several addresses fails with an `AggregateError` without a
 * message).
 */
export const reasonOf = (error: HttpClientError.HttpClientError): string => {
  const { reason } = error;
  if (Predicate.isString(reason.description) && Str.isNonEmpty(reason.description)) return reason.description;
  const cause: unknown = reason.cause;
  if (Predicate.isError(cause) && Str.isNonEmpty(cause.message)) return cause.message;
  if (Predicate.hasProperty(cause, 'code') && Predicate.isString(cause.code)) return cause.code;
  return reason._tag;
};

const unreachable = (error: HttpClientError.HttpClientError): HfUnreachable =>
  HfUnreachable.make({ message: `Hugging Face unreachable: ${reasonOf(error)}` });

/** `gated` as the Hub writes it: `false`, or how access is granted (`'manual'`, `'auto'`). */
const Gated = Schema.Union([Schema.Boolean, Schema.String]);
const isGated = (gated: Option.Option<boolean | string>): boolean => Option.exists(gated, (g) => g !== false);

const SearchRow = Schema.Struct({
  id: Schema.String,
  downloads: Schema.optionalKey(Schema.Int),
  likes: Schema.optionalKey(Schema.Int),
  gated: Schema.optionalKey(Gated),
  lastModified: Schema.optionalKey(Schema.String),
});

const RepoInfo = Schema.Struct({
  // The id makes a folder under the models folder: an id that is not `org/name` (a mirror or a proxy answering
  // `../x`) is an invalid response.
  id: Schema.String.check(Schema.isPattern(HF_REPO_RE)),
  // The commit pins the downloads (it goes into every resolve URL): anything but 40 hex is an invalid response.
  sha: Schema.String.check(Schema.isPattern(HF_COMMIT_RE)),
  gated: Schema.optionalKey(Gated),
  siblings: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        rfilename: Schema.String,
        size: Schema.optionalKey(Schema.Int),
        lfs: Schema.optionalKey(Schema.Struct({ sha256: Schema.String, size: Schema.Int })),
      }),
    ),
  ),
});

const WhoAmI = Schema.Struct({ name: Schema.optionalKey(Schema.String) });

/** The account of a token, as `whoami` told it: `invalid` when the Hub rejected the token. */
interface Account {
  readonly user: string | null;
  readonly invalid: boolean;
}

/** The Hugging Face Hub's API: the search, a repository's files, the account of the token. */
export class HfClient extends Context.Service<
  HfClient,
  {
    /** The token's source, its account (asked once per token), and the endpoint. Never fails. */
    readonly status: Effect.Effect<HfStatus>;
    /** The GGUF repositories matching `q`, most downloaded first (30 at most). */
    readonly search: (q: string) => Effect.Effect<ReadonlyArray<HfSearchHit>, HubError>;
    /** The files of repository `id` at `revision` (a branch, a tag or a commit), and the commit it resolved to. */
    readonly repoFiles: (id: string, revision: string) => Effect.Effect<RepoFiles, HubError>;
  }
>()('@llama-webui/app/server/hf/HfClient') {
  /**
   * Every call goes through `HfHttp`, in a scope of its own (it ends with the call, or when the caller is interrupted:
   * the request is aborted), within 10 s, its redirects on the endpoint's origin followed (5 at most) and its body
   * read; a 200 is decoded with a schema. The token and the endpoint are
   * read on each call (an `hf auth login` done while the app runs is used), with the configuration the client was
   * built with.
   */
  static readonly layer: Layer.Layer<HfClient, never, HfHttp | FileSystem.FileSystem> = Layer.effect(
    HfClient,
    Effect.gen(function* () {
      const http = yield* HfHttp;
      const context = yield* Effect.context<FileSystem.FileSystem>();
      // The whoami requests run here, not in their caller: a caller that leaves does not end one another waits on.
      const scope = yield* Effect.scope;
      const accounts = yield* SynchronizedRef.make<ReadonlyMap<string, Deferred.Deferred<Account>>>(new Map());

      /**
       * `request`, and the redirects it answers that stay on `origin` (the endpoint's), at most `MAX_REDIRECTS`, with
       * the same headers. Any other answer is the response: a redirect elsewhere, or one too many, is its error.
       */
      const follow = (
        request: HttpClientRequest.HttpClientRequest,
        origin: Option.Option<string>,
        hops: number,
      ): Effect.Effect<HttpClientResponse.HttpClientResponse, HttpClientError.HttpClientError, Scope.Scope> =>
        Effect.flatMap(http.execute(request), (response) => {
          const next =
            isRedirect(response.status) && hops < MAX_REDIRECTS
              ? Option.flatMap(origin, (o) => sameOrigin(response.headers.location, request.url, o))
              : Option.none();
          return Option.match(next, {
            onNone: () => Effect.succeed(response),
            onSome: (url) => follow(HttpClientRequest.get(url, { headers: request.headers }), origin, hops + 1),
          });
        });

      /** A GET of the API at `path` (its same-origin redirects followed), its 200 decoded with `schema`. */
      const api = <A, I>(
        path: string,
        schema: Schema.Codec<A, I>,
        options: {
          readonly token: string | null;
          readonly repo?: string | undefined;
          readonly urlParams?: UrlParams.Input;
        },
      ): Effect.Effect<A, HubError> =>
        Effect.gen(function* () {
          const endpoint = yield* hfEndpoint;
          const request = HttpClientRequest.get(`${endpoint}${path}`, {
            headers: hubHeaders(options.token),
            urlParams: options.urlParams ?? [],
          });
          const origin = Option.map(Option.fromNullishOr(URL.parse(endpoint)), (url) => url.origin);
          const response = yield* follow(request, origin, 0).pipe(Effect.mapError(unreachable));
          if (response.status < 200 || response.status >= 300) {
            return yield* hubError(response, { repo: options.repo, hasToken: options.token !== null });
          }
          const text = yield* response.text.pipe(Effect.mapError(unreachable));
          // A proxy or a captive portal answering 200 with a page: the Hub is the problem, not the client.
          return yield* Schema.decodeEffect(Schema.fromJsonString(schema))(text).pipe(
            Effect.mapError(() => HfUnreachable.make({ message: `Hugging Face sent an invalid response (${path})` })),
          );
        }).pipe(
          Effect.scoped,
          Effect.timeoutOrElse({
            duration: API_TIMEOUT,
            orElse: () => Effect.fail(HfUnreachable.make({ message: 'Hugging Face unreachable: no answer in 10 s' })),
          }),
          Effect.trackDuration(HfMetrics.duration),
          Effect.tap(() => Metric.update(HfMetrics.requests, 'ok')),
          Effect.tapError((error) => Metric.update(HfMetrics.requests, error._tag)),
        );

      /** The account of `token` as the Hub tells it, and whether to keep it (not after a failure of the network). */
      const askAccount = (token: string) =>
        api('/api/whoami-v2', WhoAmI, { token }).pipe(
          Effect.map((who) => ({ account: { user: who.name ?? null, invalid: false }, keep: true })),
          Effect.catchTag('HfUnauthorized', () =>
            Effect.succeed({ account: { user: null, invalid: true }, keep: true }),
          ),
          Effect.orElseSucceed(() => ({ account: { user: null, invalid: false }, keep: false })),
        );

      /** `known` without the answer `pending` of `token` (a newer one stays). */
      const forget = (
        known: ReadonlyMap<string, Deferred.Deferred<Account>>,
        token: string,
        pending: Deferred.Deferred<Account>,
      ) => (known.get(token) === pending ? new Map(Arr.filter([...known], ([key]) => key !== token)) : known);

      /**
       * The account of `token`, asked of the Hub once: the calls that come while it is asked wait for the same answer.
       * A rejected token is remembered as such; a failure of another kind (the network, the Hub, a defect) is not, so
       * the next status asks again.
       */
      const accountOf = (token: string) =>
        Effect.flatMap(
          SynchronizedRef.modifyEffect(accounts, (known) => {
            const pending = known.get(token);
            if (pending !== undefined) return Effect.as(cacheLookup('whoami'), [pending, known] as const);
            return Effect.gen(function* () {
              yield* cacheLookup('whoami');
              yield* cacheLoad('whoami');
              const asked = yield* Deferred.make<Account>();
              yield* askAccount(token).pipe(
                Effect.flatMap(({ account, keep }) =>
                  Effect.andThen(
                    keep ? Effect.void : SynchronizedRef.update(accounts, (now) => forget(now, token, asked)),
                    Deferred.succeed(asked, account),
                  ),
                ),
                // Interrupted with the client, or a defect: forgotten, and those waiting get no account rather than
                // wait forever; the next status asks again.
                Effect.onError(() =>
                  Effect.andThen(
                    SynchronizedRef.update(accounts, (now) => forget(now, token, asked)),
                    Deferred.succeed(asked, { user: null, invalid: false }),
                  ),
                ),
                Effect.forkIn(scope),
              );
              return [asked, new Map([...known, [token, asked]])] as const;
            });
          }),
          Deferred.await,
        );

      const status = Effect.gen(function* () {
        const { token, source } = yield* hfToken;
        const endpoint = yield* hfEndpoint;
        if (token === null) return { token: source, user: null, tokenInvalid: false, endpoint } satisfies HfStatus;
        const account = yield* accountOf(token);
        return { token: source, user: account.user, tokenInvalid: account.invalid, endpoint } satisfies HfStatus;
      }).pipe(Effect.provideContext(context), Effect.withSpan('HfClient.status'));

      const search = Effect.fn('HfClient.search')(function* (q: string) {
        const { token } = yield* hfToken;
        const rows = yield* api('/api/models', Schema.Array(SearchRow), {
          token,
          urlParams: [
            ['search', q],
            ['filter', 'gguf'],
            ['sort', 'downloads'],
            ['direction', '-1'],
            ['limit', '30'],
            ...Arr.map(['downloads', 'likes', 'gated', 'lastModified'], (field) => ['expand[]', field] as const),
          ],
        });
        return Arr.map(rows, (row): HfSearchHit => ({
          id: row.id,
          downloads: row.downloads ?? 0,
          likes: row.likes ?? 0,
          lastModified: row.lastModified ?? null,
          gated: isGated(Option.fromUndefinedOr(row.gated)),
        }));
      }, Effect.provideContext(context));

      const repoFiles = Effect.fn('HfClient.repoFiles')(function* (id: string, revision: string) {
        const { token } = yield* hfToken;
        const info = yield* api(`/api/models/${id}/revision/${encodeURIComponent(revision)}`, RepoInfo, {
          token,
          repo: id,
          urlParams: [['blobs', 'true']],
        });
        return {
          id: info.id,
          sha: info.sha,
          gated: isGated(Option.fromUndefinedOr(info.gated)),
          files: Arr.map(info.siblings ?? [], (sibling): HfFile => ({
            path: sibling.rfilename,
            size: sibling.lfs?.size ?? sibling.size ?? 0,
            sha256: sibling.lfs?.sha256 ?? null,
          })),
        } satisfies RepoFiles;
      }, Effect.provideContext(context));

      return HfClient.of({ status, search, repoFiles });
    }),
  );
}
