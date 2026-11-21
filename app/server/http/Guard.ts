import { RequestRefused } from '@llama-webui/shared';
import { Array as Arr, Effect, String as Str } from 'effect';
import { HttpRouter, HttpServerRequest, HttpServerResponse } from 'effect/http';
import { noTrailingSlash } from './TrailingSlash.ts';

/** A request as the guard reads it: its method, and its headers with lower-case names (Node's). */
export interface GuardedRequest {
  readonly method: string;
  readonly headers: Readonly<Record<string, string | undefined>>;
}

const MUTATING = ['POST', 'PUT', 'PATCH', 'DELETE'];

/** A dotted IPv4 address, the form `URL` gives every IPv4 host (`0x7f.1` included). */
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

/**
 * Safe hostname: localhost or a literal IP address. A domain name can be rebound to 127.0.0.1. `hostname` comes from
 * `URL`: lower case, IPv4 dotted, IPv6 in brackets (and valid, or `URL` would have refused it).
 */
const trustedHostname = (hostname: string): boolean =>
  hostname === 'localhost' ||
  Str.endsWith('.localhost')(hostname) ||
  IPV4.test(hostname) ||
  Str.startsWith('[')(hostname);

const refused = (status: number, message: string) => ({ status, message });

/**
 * Why a request to the API or to /ws is refused, if it is: status and message of the Nitro server's guard. It protects
 * the unauthenticated local API from other sites open in the browser:
 * - DNS rebinding: the Host header must be localhost or an IP (a Host that is not an authority is a 400);
 * - cross-site requests: an Origin, when present, must be the page's own (same scheme, host, port);
 * - "simple request" CSRF: a write with a body must be application/json, the body judged from its framing headers
 *   (`content-length`, `transfer-encoding`).
 */
export function refusal(request: GuardedRequest): { readonly status: number; readonly message: string } | undefined {
  const host = request.headers.host;
  const url = host === undefined ? null : URL.parse(`http://${host}`);
  if (host === undefined || url === null) return refused(400, 'Invalid host');
  if (!trustedHostname(url.hostname)) return refused(403, 'Host not allowed');

  const origin = request.headers.origin;
  // The server speaks plain HTTP: the page's own origin is `http://<Host>`.
  if (origin !== undefined && origin !== `http://${host}`) return refused(403, 'Origin not allowed');

  if (Arr.contains(MUTATING, request.method)) {
    const type = request.headers['content-type'];
    const json = type !== undefined && /^application\/json\b/i.test(type);
    const length = request.headers['content-length'];
    const body = (length !== undefined && Number(length) > 0) || request.headers['transfer-encoding'] !== undefined;
    if ((type !== undefined && !json) || (body && !json)) {
      return refused(415, 'JSON body expected (content-type: application/json)');
    }
  }
  return undefined;
}

const encodeRefusal = HttpServerResponse.schemaJson(RequestRefused);

/**
 * The guard around a route: it answers a refusal as JSON (`RequestRefused`), with `Connection: close` on an upgrade,
 * and runs the route otherwise.
 */
const guard = <E, R>(
  route: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
): Effect.Effect<HttpServerResponse.HttpServerResponse, E, R | HttpServerRequest.HttpServerRequest> =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const verdict = refusal(request);
    if (verdict === undefined) return yield* route;
    const response = yield* encodeRefusal(RequestRefused.make({ message: verdict.message }), {
      status: verdict.status,
    }).pipe(Effect.orDie);
    // An upgrade refused: the socket is not left open for another request.
    return request.headers.upgrade === undefined
      ? response
      : HttpServerResponse.setHeader(response, 'connection', 'close');
  });

/**
 * What the routes of the API and of /ws are provided (`Layer.provide(Guarded)`): the guard, then the 308 of a trailing
 * slash. It wraps the routes themselves, so it judges every request the router gives them, however its path is
 * spelled: the router ignores the case, folds repeated slashes, decodes percent escapes and cuts the path at a `;`,
 * and a guard that read the path on its own would let `/API/settings` or `/ws;x` through. The UI's routes are not
 * guarded.
 */
export const Guarded = HttpRouter.middleware((route) => route.pipe(noTrailingSlash, guard)).layer;
