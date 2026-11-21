import { defineHandler } from 'nitro';
import { ROUTES } from '../api.gen.ts';
import { allowTable } from '../lib/http.ts';
import { guard } from '../lib/security.ts';

const allow = allowTable([...ROUTES]);

/**
 * Every API request: the guard of `lib/security.ts` (host, origin, JSON), then the 405 table and the 404 of an unknown
 * route (Nitro's SPA renderer would answer both with `index.html`). `/ws` without an upgrade: the guard, then 426 (an
 * upgrade goes to `routes/ws.ts`, which guards it too).
 */
export default defineHandler((event) => {
  const path = event.url.pathname;
  if (path === '/ws' && !event.req.headers.has('upgrade'))
    return (
      guard(event.req) ??
      new Response('WebSocket upgrade expected', {
        status: 426,
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      })
    );
  if (path !== '/api' && !path.startsWith('/api/')) return;
  return guard(event.req) ?? allow(event.req.method, path);
});
