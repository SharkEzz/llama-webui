/**
 * Serves dist/ the way GitHub Pages does, for local checks: everything under /llama-webui/, "dir" redirects to
 * "dir/" when dir/index.html exists, unknown paths get 404.html with a 404 status, text is gzipped and everything is
 * cached for 10 minutes (Pages' max-age), so Lighthouse runs here are comparable.
 * Usage: bun scripts/serve.ts [--port 4173]  (listens on 0.0.0.0)
 */
import { join, normalize } from 'node:path';
import { parseArgs } from 'node:util';

const BASE = '/llama-webui';
const dist = join(import.meta.dir, '..', 'dist');
const { values } = parseArgs({ args: Bun.argv.slice(2), options: { port: { type: 'string', default: '4173' } } });

const COMPRESSIBLE = /^(text\/|application\/(javascript|json|xml)|image\/svg)/;

/** A file response, gzipped when the client accepts it and the type is text. */
async function send(req: Request, file: Blob, status = 200) {
  const headers = new Headers({ 'content-type': file.type, 'cache-control': 'max-age=600' });
  if (COMPRESSIBLE.test(file.type) && req.headers.get('accept-encoding')?.includes('gzip')) {
    headers.set('content-encoding', 'gzip');
    headers.set('vary', 'accept-encoding');
    return new Response(Bun.gzipSync(new Uint8Array(await file.arrayBuffer())), { status, headers });
  }
  return new Response(file, { status, headers });
}

async function existing(path: string) {
  const file = Bun.file(path);
  return (await file.exists()) ? file : null;
}

const server = Bun.serve({
  hostname: '0.0.0.0',
  port: Number(values.port),
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === '/' || url.pathname === BASE) return Response.redirect(`${BASE}/`, 301);
    if (!url.pathname.startsWith(`${BASE}/`)) return new Response('Not found', { status: 404 });

    const rel = normalize(decodeURIComponent(url.pathname.slice(BASE.length))).replace(/^(\.\.(\/|$))+/, '');
    const path = join(dist, rel);
    if (!url.pathname.endsWith('/')) {
      const file = await existing(path);
      if (file) return send(req, file);
      if (await existing(join(path, 'index.html'))) return Response.redirect(`${url.pathname}/${url.search}`, 301);
    } else {
      const index = await existing(join(path, 'index.html'));
      if (index) return send(req, index);
    }
    return send(req, Bun.file(join(dist, '404.html')), 404);
  },
});

console.log(`Serving dist/ like GitHub Pages at http://${server.hostname}:${server.port}${BASE}/`);
