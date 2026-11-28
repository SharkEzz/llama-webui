import { Schema } from 'effect';
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from 'effect/http-api';
import { HF_REPO_RE, HfRepo, HfSearchHit, HfStatus } from '../hf.ts';

/** The repository is gated and its license not accepted: `<repo> is gated: accept its license on Hugging Face…`. */
export class HfGated extends Schema.TaggedError<HfGated, { readonly HfGated: unique symbol }>()(
  'HfGated',
  { message: Schema.String },
  { httpApiStatus: 403, description: 'HfGated: The Hugging Face repository is gated and its license is not accepted.' },
) {}

/** The Hub knows no such repository (`… not found on Hugging Face (or private…)`) or no such GGUF in it (`No GGUF “<key>” in <repo>`). */
export class HfNotFound extends Schema.TaggedError<HfNotFound, { readonly HfNotFound: unique symbol }>()(
  'HfNotFound',
  { message: Schema.String },
  {
    httpApiStatus: 404,
    description: 'HfNotFound: Repository or requested GGUF variant was not found on Hugging Face.',
  },
) {}

/** The Hub refused the token: `Hugging Face rejected the token`. */
export class HfUnauthorized extends Schema.TaggedError<HfUnauthorized, { readonly HfUnauthorized: unique symbol }>()(
  'HfUnauthorized',
  { message: Schema.String },
  { httpApiStatus: 401, description: 'HfUnauthorized: Hugging Face rejected the configured access token.' },
) {}

/** The Hub's rate limit: `Hugging Face rate limit reached, try again later`. */
export class HfRateLimited extends Schema.TaggedError<HfRateLimited, { readonly HfRateLimited: unique symbol }>()(
  'HfRateLimited',
  { message: Schema.String },
  { httpApiStatus: 429, description: 'HfRateLimited: Hugging Face Hub API rate limit was exceeded.' },
) {}

/**
 * The Hub did not answer, or not as expected: `Hugging Face error <status>[: <x-error-message>]`,
 * `Hugging Face unreachable: <reason>`, `Hugging Face sent an invalid response (<path>)`,
 * `Too many redirects from Hugging Face`.
 */
export class HfUnreachable extends Schema.TaggedError<HfUnreachable, { readonly HfUnreachable: unique symbol }>()(
  'HfUnreachable',
  { message: Schema.String },
  {
    httpApiStatus: 502,
    description: 'HfUnreachable: Network error, unexpected status or invalid reply from Hugging Face.',
  },
) {}

/** A file of the repository whose path would leave its folder: `Invalid file path in the repository: <path>`. */
export class HfInvalidPath extends Schema.TaggedError<HfInvalidPath, { readonly HfInvalidPath: unique symbol }>()(
  'HfInvalidPath',
  { message: Schema.String },
  {
    httpApiStatus: 400,
    description: 'HfInvalidPath: A file path inside the repository escapes the destination directory.',
  },
) {}

/** What a call to the Hub may answer. */
export const HubErrors = [HfGated, HfNotFound, HfUnauthorized, HfRateLimited, HfUnreachable] as const;

/** A repository id (`org/name`); a missing one reads as an empty id. */
const RepoId = Schema.String.check(
  Schema.makeFilter((id: string) => HF_REPO_RE.test(id) || `Invalid repository id: ${id}`),
).pipe(Schema.annotateKey({ messageMissingKey: 'Invalid repository id: ' }));

const searchText = 'Search text expected (200 characters at most)';
/** A search of the Hub: trimmed, 1 to 200 characters. */
const SearchText = Schema.Trim.check(
  Schema.isMinLength(1, { message: searchText }),
  Schema.isMaxLength(200, { message: searchText }),
).pipe(Schema.annotateKey({ messageMissingKey: searchText }));

/** Hugging Face: a repository's GGUF variants and what of them is on disk, the search, the account of the token. */
export class HfApi extends HttpApiGroup.make('hf')
  .add(
    // `revision` omitted: the default branch; the reply's `sha` pins the downloads.
    HttpApiEndpoint.get('repo', '/api/hf/repo', {
      query: { id: RepoId, revision: Schema.optionalKey(Schema.String) },
      success: HfRepo,
      error: [...HubErrors, HfInvalidPath],
    }).annotateMerge(
      OpenApi.annotations({
        summary: 'Inspect a Hugging Face repository',
        description:
          'Lists all GGUF model variants and multimodal projectors in `org/name` at the given `revision` (or default branch), pinning the commit `sha` and comparing each file against local disk presence.',
      }),
    ),
    HttpApiEndpoint.get('search', '/api/hf/search', {
      query: { q: SearchText },
      success: Schema.Array(HfSearchHit),
      error: HubErrors,
    }).annotateMerge(
      OpenApi.annotations({
        summary: 'Search GGUF repositories on Hugging Face',
        description: 'Searches Hugging Face for GGUF-tagged repositories matching `q` (1–200 characters).',
      }),
    ),
    HttpApiEndpoint.get('status', '/api/hf/status', { success: HfStatus }).annotateMerge(
      OpenApi.annotations({
        summary: 'Check Hugging Face token status',
        description:
          'Reports the active token source (`HF_TOKEN` env var or `hf auth login` file), cached account name (`whoami`), and configured `HF_ENDPOINT`.',
      }),
    ),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: 'Hugging Face',
      description:
        'Search and inspect GGUF repositories on Hugging Face Hub. Uses `HF_TOKEN` (or `hf auth login` token file), `HF_ENDPOINT`, and `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY`.',
    }),
  ) {}
