import { Array as Arr, Option, Schema, SchemaIssue } from 'effect';

/** The guard refused the request (host, origin or body type): its status is the one the guard chose. */
export class RequestRefused extends Schema.TaggedError<RequestRefused, { readonly RequestRefused: unique symbol }>()(
  'RequestRefused',
  { message: Schema.String },
  { description: 'RequestRefused: Request blocked by the Host, Origin or JSON Content-Type guard (400, 403 or 415).' },
) {}

/** No endpoint of the API matches the path: `Unknown route`. */
export class RouteNotFound extends Schema.TaggedError<RouteNotFound, { readonly RouteNotFound: unique symbol }>()(
  'RouteNotFound',
  { message: Schema.String },
  {
    httpApiStatus: 404,
    description: 'RouteNotFound: Unknown path, unsupported HTTP method, or non-integer :id path parameter.',
  },
) {}

/** One field a request fails on: its path (keys and indexes as strings) and why. */
export const Issue = Schema.Struct({ path: Schema.Array(Schema.String), message: Schema.String }).annotate({
  identifier: 'ValidationIssue',
  description: 'One schema validation failure with its field path segments and human-readable message.',
});
export type Issue = typeof Issue.Type;

const format = SchemaIssue.makeFormatterStandardSchemaV1();

/**
 * `HttpApiBuilder` wraps even a single payload schema in `Schema.Union([schema])`, so a non-object body produces an
 * empty `AnyOf` whose outer union AST has no `message` annotation and would otherwise format the member's OpenAPI
 * `identifier` instead of its `message`. Unwrap a single-member empty `AnyOf` so the member's own message applies.
 */
const unwrapSingleAnyOf = (issue: SchemaIssue.Issue): SchemaIssue.Issue => {
  if (issue._tag === 'AnyOf' && issue.issues.length === 0 && issue.ast.types.length === 1) {
    const member = issue.ast.types[0];
    if (member !== undefined) return new SchemaIssue.InvalidType(member);
  }
  return issue;
};

/** The issues of a decode failure, in the order Schema reports them. */
export const issuesOf = (issue: SchemaIssue.Issue): ReadonlyArray<Issue> =>
  Arr.map(format(unwrapSingleAnyOf(issue)).issues, (one) => ({
    path: Arr.map(one.path ?? [], (segment) => String(typeof segment === 'object' ? segment.key : segment)),
    message: one.message,
  }));

/** A request whose payload or query does not decode: 400, `Invalid data: <first message>[ (<path joined by '.'>)]`. */
export class RequestInvalid extends Schema.TaggedError<RequestInvalid, { readonly RequestInvalid: unique symbol }>()(
  'RequestInvalid',
  { message: Schema.String, issues: Schema.Array(Issue) },
  {
    httpApiStatus: 400,
    description: 'RequestInvalid: Request body, query string or header failed strict schema validation.',
  },
) {}

/** How an issue reads in a sentence: its message, then its path when it has one. */
export const describeIssue = (issue: Issue): string =>
  Arr.isReadonlyArrayNonEmpty(issue.path) ? `${issue.message} (${Arr.join(issue.path, '.')})` : issue.message;

/** The `RequestInvalid` of a decode failure. */
export const requestInvalid = (issue: SchemaIssue.Issue): RequestInvalid => {
  const issues = issuesOf(issue);
  return RequestInvalid.make({
    message: Option.match(Arr.head(issues), {
      onNone: () => 'Invalid data',
      onSome: (first) => `Invalid data: ${describeIssue(first)}`,
    }),
    issues,
  });
};
