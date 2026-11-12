import { readdir, readFile } from 'node:fs/promises';
import { extname, join, relative } from 'node:path';
import type { WebHandler } from '../host';

/*
 * Web UI: in development, Vite's middlewares (HMR, `server/dev.ts`); in production, the files `vite build` wrote to
 * `dist/web`, split per page (each page loads its own chunks: the Topology page's three.js stays out of the others).
 */

/** Types of the files `vite build` writes to `dist/web`, as Bun's bundler typed them. */
const TYPES: Record<string, string> = {
  '.html': 'text/html;charset=utf-8',
  '.js': 'text/javascript;charset=utf-8',
  '.css': 'text/css;charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.json': 'application/json;charset=utf-8',
  '.wasm': 'application/wasm',
};

/**
 * The built UI (`dist/web`), read into memory once: a file's exact path → its bytes, immutable (content-hashed
 * names); any other path → `index.html`, never cached, since it points to the current chunks (SPA fallback:
 * reloading /chat/12 works). Rejects when the directory has no `index.html`.
 */
export async function staticWeb(dir: string): Promise<WebHandler> {
  const index = await readFile(join(dir, 'index.html'));
  const files = new Map<string, { body: Buffer; type: string }>();
  for (const e of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (!e.isFile()) continue;
    const path = join(e.parentPath, e.name);
    const type = TYPES[extname(e.name)] ?? 'application/octet-stream';
    files.set(`/${relative(dir, path)}`, { body: await readFile(path), type });
  }
  files.delete('/index.html');
  return (req, res) => {
    const file = files.get((req.url ?? '/').split('?', 1)[0] ?? '/');
    if (file) {
      res.writeHead(200, { 'Content-Type': file.type, 'Cache-Control': 'public, max-age=31536000, immutable' });
      res.end(file.body);
    } else {
      res.writeHead(200, { 'Content-Type': 'text/html;charset=utf-8', 'Cache-Control': 'no-cache' }).end(index);
    }
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
