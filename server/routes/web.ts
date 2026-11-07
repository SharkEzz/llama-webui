import { basename } from 'node:path';
import tailwind from 'bun-plugin-tailwind';

/*
 * Web UI. In development, Bun.serve's HTML import (HMR). In production, Bun.serve would also bundle the page on the
 * fly, but into a single file: it ignores code splitting and inlines the router's import()s, so every page loaded
 * everything (including the Topology page's three.js, ~1 MB). Bun.build does split: the front end is built at
 * startup, in memory (no build step), and each page only loads its own chunks.
 */

/** UI routes for Bun.serve: built files and SPA fallback (`/*`). */
export type WebRoutes = Record<string, Bun.HTMLBundle | Response>;

export async function buildWebRoutes(entry: string): Promise<WebRoutes> {
  const result = await Bun.build({
    entrypoints: [entry],
    target: 'browser',
    splitting: true,
    minify: true,
    // Absolute paths: a deep URL (/chat/12) must not look for its chunks under /chat/.
    publicPath: '/',
    plugins: [tailwind],
    define: { 'process.env.NODE_ENV': '"production"' },
  });
  if (!result.success) {
    throw new AggregateError(result.logs, `failed to build the web UI (${entry})`);
  }
  const routes: WebRoutes = {};
  let html: string | null = null;
  for (const out of result.outputs) {
    const name = basename(out.path);
    if (name.endsWith('.html')) {
      html = await out.text();
      continue;
    }
    // Content-hashed names: immutable.
    routes[`/${name}`] = new Response(await out.arrayBuffer(), {
      headers: { 'Content-Type': out.type, 'Cache-Control': 'public, max-age=31536000, immutable' },
    });
  }
  if (html === null) throw new Error(`web UI build: no HTML produced (${entry})`);
  // Any other path serves the app (SPA fallback); never cached, since it points to the current chunks.
  routes['/*'] = new Response(html, {
    headers: { 'Content-Type': 'text/html;charset=utf-8', 'Cache-Control': 'no-cache' },
  });
  return routes;
}

/**
 * Build failed (broken import, failing plugin): the API, the WebSocket and the supervisor are still served;
 * every page answers 503 with the error, until the next startup.
 */
export function unavailableWebRoutes(err: unknown): WebRoutes {
  const detail = err instanceof AggregateError ? [err.message, ...err.errors.map(String)] : [String(err)];
  return {
    '/*': new Response(`llama-webui: web UI unavailable.\n\n${detail.join('\n')}\n`, {
      status: 503,
      headers: { 'Content-Type': 'text/plain;charset=utf-8', 'Cache-Control': 'no-store' },
    }),
  };
}
