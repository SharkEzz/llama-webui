import { defineHandler } from 'nitro';
import { ROUTES } from '../api.gen.ts';
import { allowTable } from '../lib/http.ts';
import { guard } from '../lib/security.ts';

const allow = allowTable([...ROUTES]);

/**
 * Every API request: the guard of `lib/security.ts` (host, origin, JSON), then the 405 table and the 404 of an unknown
 * route (Nitro's SPA renderer would answer both with `index.html`).
 */
export default defineHandler((event) => {
  const path = event.url.pathname;
  if (path !== '/api' && !path.startsWith('/api/')) return;
  return guard(event.req) ?? allow(event.req.method, path);
});
