import {
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
  Effect,
  type FileSystem,
  Layer,
  Option,
  Predicate,
  Schema,
  String as Str,
  SynchronizedRef,
} from 'effect';
import { dual } from 'effect/Function';
import { type HttpClientError, HttpClientRequest, type HttpClientResponse, type UrlParams } from 'effect/http';
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

/** How long a call to the Hub's API may take, its body read. */
const API_TIMEOUT = '10 seconds';

/**
 * The error of a Hub answer that is not a success: its `x-error-code` first (a private or missing repository answers
 * 401 `RepoNotFound` without a token), then its status. `repo` names what was asked for; without a token, the messages
 * say where to set one.
 */
export const hubError: {
  (options: {
    readonly repo?: string;
    readonly hasToken: boolean;
  }): (response: HttpClientResponse.HttpClientResponse) => HubError;
  (
    response: HttpClientResponse.HttpClientResponse,
    options: { readonly repo?: string; readonly hasToken: boolean },
  ): HubError;
} = dual(
  2,
  (
    response: HttpClientResponse.HttpClientResponse,
    options: { readonly repo?: string; readonly hasToken: boolean },
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
const reasonOf = (error: HttpClientError.HttpClientError): string => {
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
  id: Schema.String,
  sha: Schema.String,
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
   * the request is aborted), within 10 s, its body read; a 200 is decoded with a schema. The token and the endpoint are
   * read on each call (an `hf auth login` done while the app runs is used), with the configuration the client was
   * built with.
   */
  static readonly layer: Layer.Layer<HfClient, never, HfHttp | FileSystem.FileSystem> = Layer.effect(
    HfClient,
    Effect.gen(function* () {
      const http = yield* HfHttp;
      const context = yield* Effect.context<FileSystem.FileSystem>();
      const accounts = yield* SynchronizedRef.make<ReadonlyMap<string, Account>>(new Map());

      /** A GET of the API at `path`, its 200 decoded with `schema`. */
      const api = <A, I>(
        path: string,
        schema: Schema.Codec<A, I>,
        options: { readonly token: string | null; readonly repo?: string; readonly urlParams?: UrlParams.Input },
      ): Effect.Effect<A, HubError> =>
        Effect.gen(function* () {
          const endpoint = yield* hfEndpoint;
          const request = HttpClientRequest.get(`${endpoint}${path}`, {
            headers: hubHeaders(options.token),
            urlParams: options.urlParams ?? [],
          });
          const response = yield* http.execute(request).pipe(Effect.mapError(unreachable));
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
        );

      /**
       * The account of `token`, asked of the Hub once: a rejected token is remembered as such, a failure of another
       * kind (the network, the Hub) is not, so the next status asks again.
       */
      const accountOf = (token: string) =>
        SynchronizedRef.modifyEffect(accounts, (known) => {
          const cached = known.get(token);
          if (cached !== undefined) return Effect.succeed([cached, known] as const);
          return api('/api/whoami-v2', WhoAmI, { token }).pipe(
            Effect.map((who): Option.Option<Account> => Option.some({ user: who.name ?? null, invalid: false })),
            Effect.catchTag('HfUnauthorized', () => Effect.succeedSome<Account>({ user: null, invalid: true })),
            Effect.orElseSucceed(() => Option.none<Account>()),
            Effect.map((account) =>
              Option.match(account, {
                onNone: () => [{ user: null, invalid: false }, known] as const,
                onSome: (checked) => [checked, new Map([...known, [token, checked]])] as const,
              }),
            ),
          );
        });

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
        return Arr.map(
          rows,
          (row): HfSearchHit => ({
            id: row.id,
            downloads: row.downloads ?? 0,
            likes: row.likes ?? 0,
            lastModified: row.lastModified ?? null,
            gated: isGated(Option.fromUndefinedOr(row.gated)),
          }),
        );
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
          files: Arr.map(
            info.siblings ?? [],
            (sibling): HfFile => ({
              path: sibling.rfilename,
              size: sibling.lfs?.size ?? sibling.size ?? 0,
              sha256: sibling.lfs?.sha256 ?? null,
            }),
          ),
        } satisfies RepoFiles;
      }, Effect.provideContext(context));

      return HfClient.of({ status, search, repoFiles });
    }),
  );
}
