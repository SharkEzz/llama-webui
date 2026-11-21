import { Array as Arr, Effect, pipe, String as Str } from 'effect';
import { HttpServerRequest, HttpServerResponse } from 'effect/http';
import { withoutTrailingSlash } from '../config/paths.ts';

/** The path of a request target, without its query or fragment. */
const pathOf = (url: string): string => Arr.headNonEmpty(Str.split(url, /[?#]/));

/**
 * Around a route of the API or of /ws (the router matches a path with or without its last slash): a path that ends
 * with a slash is answered 308 to the same path without its trailing slashes, query string kept; any other request
 * runs the route. A 308 keeps the method and the body, so a client that follows it replays a write as it was.
 *
 * The target is always a path of this server: its leading slashes are folded into one (the router matched
 * `//api/settings/`, and a `Location` of `//api/settings` would name the host `api`), and a target that is not a path
 * (`http://host/api/settings/`, the absolute form) is not redirected.
 */
export const noTrailingSlash = <E, R>(
  route: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
): Effect.Effect<HttpServerResponse.HttpServerResponse, E, R | HttpServerRequest.HttpServerRequest> =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const path = pathOf(request.url);
    if (!Str.startsWith('/')(path) || !Str.endsWith('/')(path)) return yield* route;
    const query = Str.slice(path.length)(request.url);
    const target = pipe(path, Str.replace(/^\/+/, '/'), withoutTrailingSlash);
    return HttpServerResponse.redirect(`${target}${query}`, { status: 308 });
  });
