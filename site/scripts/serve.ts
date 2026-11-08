/**
 * Serves dist/ the way GitHub Pages does, for local checks: everything under /llama-webui/, "dir" redirects to
 * "dir/" when dir/index.html exists, and unknown paths get 404.html with a 404 status.
 * Usage: bun scripts/serve.ts [--port 4173]  (listens on 0.0.0.0)
 */
import { join, normalize } from 'node:path';
import { parseArgs } from 'node:util';

const BASE = '/llama-webui';
const dist = join(import.meta.dir, '..', 'dist');
const { values } = parseArgs({ args: Bun.argv.slice(2), options: { port: { type: 'string', default: '4173' } } });

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
      if (file) return new Response(file);
      if (await existing(join(path, 'index.html'))) return Response.redirect(`${url.pathname}/${url.search}`, 301);
    } else {
      const index = await existing(join(path, 'index.html'));
      if (index) return new Response(index);
    }
    return new Response(Bun.file(join(dist, '404.html')), { status: 404, headers: { 'content-type': 'text/html' } });
  },
});

console.log(`Serving dist/ like GitHub Pages at http://${server.hostname}:${server.port}${BASE}/`);
