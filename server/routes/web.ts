import { readdir, readFile } from 'node:fs/promises';
import { extname, join, relative } from 'node:path';
import { pathOf, type WebHandler } from '../host';

/*
 * Web UI: in development, Vite's middlewares (HMR, `server/dev.ts`); in production, the files `vite build` wrote to
 * `dist/web`, split per page (each page loads its own chunks: the Topology page's three.js stays out of the others).
 */

const HTML = 'text/html;charset=utf-8';
const IMMUTABLE = 'public, max-age=31536000, immutable';

/** Types of the files `vite build` writes to `dist/web`. */
const TYPES: Record<string, string> = {
  '.html': HTML,
  '.js': 'text/javascript;charset=utf-8',
  '.css': 'text/css;charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
};

/**
 * The built UI (`dist/web`), read into memory once: a file's exact path → its bytes, immutable (content-hashed
 * names); any other path → `index.html`, never cached, since it points to the current chunks (SPA fallback:
 * reloading /chat/12 works). Rejects when the directory has no `index.html`.
 */
export async function staticWeb(dir: string): Promise<WebHandler> {
  const index = { body: await readFile(join(dir, 'index.html')), type: HTML, cache: 'no-cache' };
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  const files = new Map<string, typeof index>(
    await Promise.all(
      entries
        .filter((e) => e.isFile())
        .map(async (e) => {
          const path = join(e.parentPath, e.name);
          const type = TYPES[extname(e.name)] ?? 'application/octet-stream';
          return [`/${relative(dir, path)}`, { body: await readFile(path), type, cache: IMMUTABLE }] as const;
        }),
    ),
  );
  files.delete('/index.html');
  return (req, res) => {
    const file = files.get(pathOf(req)) ?? index;
    // An explicit length: headers written before the body would otherwise be sent chunked, and HEAD with no length.
    res.writeHead(200, {
      'Content-Type': file.type,
      'Content-Length': file.body.length,
      'Cache-Control': file.cache,
    });
    res.end(file.body);
  };
}

/**
 * No built UI (missing or unreadable `dist/web`): the API, the WebSocket and the supervisor are still served; every
 * page answers 503 with the error, until the next startup.
 */
export function unavailableWeb(err: unknown): WebHandler {
  const text = `llama-webui: web UI unavailable.\n\n${err instanceof Error ? err.message : String(err)}\n`;
  return (_req, res) => {
    res.writeHead(503, { 'Content-Type': 'text/plain;charset=utf-8', 'Cache-Control': 'no-store' }).end(text);
  };
}
