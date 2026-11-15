import { Array as Arr, Option, Schema, SchemaIssue } from 'effect';

/** The guard refused the request (host, origin or body type): its status is the one the guard chose. */
export class RequestRefused extends Schema.TaggedError<RequestRefused, { readonly RequestRefused: unique symbol }>()(
  'RequestRefused',
  { message: Schema.String },
) {}

/** No endpoint of the API matches the path: `Unknown route`. */
export class RouteNotFound extends Schema.TaggedError<RouteNotFound, { readonly RouteNotFound: unique symbol }>()(
  'RouteNotFound',
  { message: Schema.String },
  { httpApiStatus: 404 },
) {}

/** One field a request fails on: its path (keys and indexes as strings) and why. */
export const Issue = Schema.Struct({ path: Schema.Array(Schema.String), message: Schema.String });
export type Issue = typeof Issue.Type;

const format = SchemaIssue.makeFormatterStandardSchemaV1();

/** The issues of a decode failure, in the order Schema reports them. */
export const issuesOf = (issue: SchemaIssue.Issue): ReadonlyArray<Issue> =>
  Arr.map(format(issue).issues, (one) => ({
    path: Arr.map(one.path ?? [], (segment) => String(typeof segment === 'object' ? segment.key : segment)),
    message: one.message,
  }));

/** A request whose payload or query does not decode: 400, `Invalid data: <first message>[ (<path joined by '.'>)]`. */
export class RequestInvalid extends Schema.TaggedError<RequestInvalid, { readonly RequestInvalid: unique symbol }>()(
  'RequestInvalid',
  { message: Schema.String, issues: Schema.Array(Issue) },
  { httpApiStatus: 400 },
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
