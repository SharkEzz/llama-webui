import { defineMiddleware, HTTPResponse } from 'nitro/h3';

/**
 * The SPA's page is revalidated on every load: a new build's `index.html` names new hashed assets. Nitro sets only the
 * assets' own `immutable` cache; the API sets none (live local data). The renderer answers with h3's `HTTPResponse`,
 * a handler with a web `Response`: both carry their headers.
 */
export default defineMiddleware(async (_event, next) => {
  const res = await next();
  if (
    (res instanceof Response || res instanceof HTTPResponse) &&
    res.headers.get('content-type')?.startsWith('text/html') &&
    !res.headers.has('cache-control')
  )
    res.headers.set('cache-control', 'no-cache');
  return res;
});
