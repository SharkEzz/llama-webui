import { isIP } from 'node:net';

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function forbidden(message: string, status = 403): Response {
  return Response.json({ error: message }, { status });
}

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
export function guard(req: Request): Response | undefined {
  const url = new URL(req.url);
  const host = req.headers.get('host') ?? url.host;
  let hostname: string;
  try {
    hostname = new URL(`http://${host}`).hostname;
  } catch {
    return forbidden('Invalid host');
  }
  if (!trustedHostname(hostname)) return forbidden('Host not allowed');

  const origin = req.headers.get('origin');
  if (origin !== null && origin !== `${url.protocol}//${host}`) return forbidden('Origin not allowed');

  if (MUTATING.has(req.method)) {
    const type = req.headers.get('content-type');
    const json = type !== null && /^application\/json\b/i.test(type);
    if ((type !== null && !json) || (req.body !== null && !json)) {
      return forbidden('JSON body expected (content-type: application/json)', 415);
    }
  }
  return undefined;
}
