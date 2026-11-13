import { isIP } from 'node:net';

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

const forbidden = (message: string, status = 403): Response => Response.json({ error: message }, { status });

/** Safe hostname: localhost or a literal IP address. A domain name can be rebound to 127.0.0.1. */
function trustedHostname(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return h === 'localhost' || h.endsWith('.localhost') || isIP(h) !== 0;
}

/**
 * Protects the unauthenticated local API from other sites open in the browser:
 * - DNS rebinding: the Host header must be localhost or an IP;
 * - cross-site requests: an Origin, when present, must be the page's own (same scheme, host, port);
 * - “simple request” CSRF: a write with a body must be application/json.
 * Returns an error response, or undefined if the request passes.
 */
export function guard(req: Pick<Request, 'url' | 'method' | 'headers'>): Response | undefined {
  // `req.url` is built from the Host header (server/host.ts): a Host that is not an authority (`a b`) makes it unparsable too.
  let url: URL;
  let host: string;
  let hostname: string;
  try {
    url = new URL(req.url);
    host = req.headers.get('host') ?? url.host;
    hostname = new URL(`http://${host}`).hostname;
  } catch {
    // Not a refusal of ours: an invalid Host is a malformed request (RFC 9112 §3.2), which the host's HTTP adapter
    // answers 400 itself before the API is reached.
    return forbidden('Invalid host', 400);
  }
  if (!trustedHostname(hostname)) return forbidden('Host not allowed');

  const origin = req.headers.get('origin');
  if (origin !== null && origin !== `${url.protocol}//${host}`) return forbidden('Origin not allowed');

  if (MUTATING.has(req.method)) {
    const type = req.headers.get('content-type');
    const json = type !== null && /^application\/json\b/i.test(type);
    // From the headers, not `req.body`: Node's adapter (`@hono/node-server`) gives every write a body stream, even
    // a body-less one. Over HTTP/1.1 a body comes with a content-length or a transfer-encoding.
    const length = req.headers.get('content-length');
    const body = (length !== null && Number(length) > 0) || req.headers.has('transfer-encoding');
    if ((type !== null && !json) || (body && !json)) {
      return forbidden('JSON body expected (content-type: application/json)', 415);
    }
  }
  return undefined;
}
