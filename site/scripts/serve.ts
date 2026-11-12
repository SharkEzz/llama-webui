/**
 * Serves dist/ the way GitHub Pages does, for local checks: everything under /llama-webui/, "dir" redirects to
 * "dir/" when dir/index.html exists, unknown paths get 404.html with a 404 status, text is gzipped and everything is
 * cached for 10 minutes (Pages' max-age), so Lighthouse runs here are comparable.
 * Usage: pnpm preview [--port 4173]  (node scripts/serve.ts, listens on 0.0.0.0)
 */
import { readFile, stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { parseArgs } from 'node:util';
import { gzipSync } from 'node:zlib';
import { cliArgs } from './argv.ts';

const BASE = '/llama-webui';

/** The types of the files the site ships (Node has no lookup), as Bun reported them; anything else is binary. */
const TYPES: Record<string, string> = {
  '.html': 'text/html;charset=utf-8',
  '.css': 'text/css;charset=utf-8',
  '.js': 'text/javascript;charset=utf-8',
  '.json': 'application/json;charset=utf-8',
  '.txt': 'text/plain;charset=utf-8',
  '.xml': 'application/xml',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
};
const typeOf = (path: string) => TYPES[extname(path)] ?? 'application/octet-stream';

const COMPRESSIBLE = /^(text\/|application\/(javascript|json|xml)|image\/svg)/;

/** A file response, gzipped when the client accepts it and the type is text. */
async function send(req: IncomingMessage, res: ServerResponse, path: string, status = 200) {
  const type = typeOf(path);
  let body = await readFile(path);
  const headers: Record<string, string> = { 'content-type': type, 'cache-control': 'max-age=600' };
  if (COMPRESSIBLE.test(type) && req.headers['accept-encoding']?.includes('gzip')) {
    headers['content-encoding'] = 'gzip';
    headers.vary = 'accept-encoding';
    body = gzipSync(body);
  }
  res.writeHead(status, { ...headers, 'content-length': String(body.length) });
  res.end(req.method === 'HEAD' ? undefined : body);
}

function redirect(res: ServerResponse, location: string) {
  res.writeHead(301, { location, 'content-length': '0' }).end();
}

const isFile = (path: string) =>
  stat(path).then(
    (s) => s.isFile(),
    () => false,
  );

/** The preview server for `dist` (not listening yet). */
export function serveDist(dist: string): Server {
  return createServer(async (req, res) => {
    try {
      // Parsed as a URL, like Bun did: `..` and `%2e%2e` segments are resolved before the base is checked.
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname === '/' || url.pathname === BASE) return redirect(res, `${BASE}/`);
      if (!url.pathname.startsWith(`${BASE}/`)) {
        res.writeHead(404, { 'content-type': 'text/plain;charset=utf-8', 'content-length': '9' });
        return res.end(req.method === 'HEAD' ? undefined : 'Not found');
      }

      const rel = normalize(decodeURIComponent(url.pathname.slice(BASE.length))).replace(/^(\.\.(\/|$))+/, '');
      const path = join(dist, rel);
      if (!url.pathname.endsWith('/')) {
        if (await isFile(path)) return await send(req, res, path);
        if (await isFile(join(path, 'index.html'))) return redirect(res, `${url.pathname}/${url.search}`);
      } else if (await isFile(join(path, 'index.html'))) {
        return await send(req, res, join(path, 'index.html'));
      }
      await send(req, res, join(dist, '404.html'), 404);
    } catch (err) {
      console.error(`serve: ${req.url}: ${err instanceof Error ? err.message : String(err)}`);
      if (!res.headersSent) res.writeHead(500);
      res.end();
    }
  });
}

if (import.meta.main) {
  const { values } = parseArgs({
    args: cliArgs(),
    options: { port: { type: 'string', default: '4173' } },
  });
  const hostname = '0.0.0.0';
  const port = Number(values.port);
  serveDist(join(import.meta.dirname, '..', 'dist')).listen(port, hostname, () => {
    console.log(`Serving dist/ like GitHub Pages at http://${hostname}:${port}${BASE}/`);
  });
}
