import { basename } from 'node:path';

/*
 * Web UI, served three ways:
 * - development (`bun run dev`): Bun.serve's HTML import, with HMR;
 * - production from source (`bun run start`): Bun.serve would also bundle the page on the fly, but into a single
 *   file: it ignores code splitting and inlines the router's import()s, so every page loaded everything (including
 *   the Topology page's three.js, ~1 MB). Bun.build does split: the front end is built at startup, in memory (no
 *   build step), and each page only loads its own chunks;
 * - standalone executable (`bun run compile`): the HTML import is bundled (and split) at compile time, with the same
 *   options, and embedded in the binary; Bun.serve serves that manifest.
 */

/** Front-end bundler options shared by the startup build and the compiled executable (`scripts/compile.ts`). */
export const WEB_BUILD_OPTIONS = {
  splitting: true,
  minify: true,
  // Absolute paths: a deep URL (/chat/12) must not look for its chunks under /chat/.
  publicPath: '/',
  define: { 'process.env.NODE_ENV': '"production"' },
} as const satisfies Partial<Bun.BuildConfig>;

/**
 * Bundler plugins of the front end (a plugin added to `bunfig.toml` goes here too). Loaded lazily: the compiled
 * executable never builds the UI, so Tailwind (and its native binding) stays out of it.
 */
export async function webPlugins(): Promise<Bun.BunPlugin[]> {
  const { default: tailwind } = await import('bun-plugin-tailwind');
  return [tailwind];
}

/** UI routes for Bun.serve: built files and SPA fallback (`/*`). */
export type WebRoutes = Record<string, Bun.HTMLBundle | Response>;

export async function buildWebRoutes(entry: string): Promise<WebRoutes> {
  const result = await Bun.build({
    ...WEB_BUILD_OPTIONS,
    entrypoints: [entry],
    target: 'browser',
    plugins: await webPlugins(),
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
