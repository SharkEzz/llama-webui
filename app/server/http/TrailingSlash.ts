import { Effect, String as Str } from 'effect';
import { HttpServerRequest, HttpServerResponse } from 'effect/http';
import { pathOf } from './Guard.ts';

/** The paths whose trailing slash goes: under the API and the WebSocket. The UI's paths are the router's of the page. */
const redirected = (path: string): boolean =>
  (Str.startsWith('/api/')(path) || Str.startsWith('/ws/')(path)) && Str.endsWith('/')(path);

/**
 * A path under /api/ or /ws/ that ends with a slash is answered 308 to the same path without its trailing slashes,
 * query string kept; any other request goes on. The target starts with `/api` or `/ws`: always a path of this server.
 * A 308 keeps the method and the body, so a client that follows it replays a write as it was.
 */
export const noTrailingSlash = <E, R>(
  app: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
): Effect.Effect<HttpServerResponse.HttpServerResponse, E, R | HttpServerRequest.HttpServerRequest> =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const path = pathOf(request.url);
    if (!redirected(path)) return yield* app;
    const query = Str.slice(path.length)(request.url);
    return HttpServerResponse.redirect(`${Str.replace(/\/+$/, '')(path)}${query}`, { status: 308 });
  });
