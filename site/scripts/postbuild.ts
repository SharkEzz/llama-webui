/**
 * Turns React Router's build output into the folder deployed to GitHub Pages (dist/).
 *
 * With basename "/llama-webui/", React Router writes prerendered pages under build/client/llama-webui/ and the SPA
 * fallback at build/client/index.html, while GitHub Pages already serves the artifact under /llama-webui/. So:
 *   - build/client/llama-webui/**  -> dist/**       (prerendered pages)
 *   - build/client/index.html      -> dist/404.html (SPA fallback: hydrates any unknown URL into the 404 route)
 *   - everything else (assets/, favicon…) is copied as is; build/client/.vite is dropped.
 * Then writes dist/sitemap.xml with trailing-slash URLs, and indexes the documentation for search into dist/pagefind/
 * (only the content marked data-pagefind-body: the docs article, not the home page).
 */
import { cpSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { join, relative } from 'node:path';
import * as pagefind from 'pagefind';
import { SITE } from '../src/lib/site.ts';

const root = join(import.meta.dir, '..');
const client = join(root, 'build/client');
const dist = join(root, 'dist');
const basenameDir = join(client, 'llama-webui');

if (!existsSync(join(client, 'index.html'))) {
  console.error('postbuild: build/client/index.html not found, run `react-router build` first');
  process.exit(1);
}

rmSync(dist, { recursive: true, force: true });
for (const entry of readdirSync(client)) {
  if (entry === 'llama-webui' || entry === 'index.html' || entry === '.vite') continue;
  cpSync(join(client, entry), join(dist, entry), { recursive: true });
}
if (existsSync(basenameDir)) cpSync(basenameDir, dist, { recursive: true });
cpSync(join(client, 'index.html'), join(dist, '404.html'));

const pages = [...new Bun.Glob('**/index.html').scanSync(dist)]
  .map((file) => relative('.', file).replace(/index\.html$/, ''))
  .sort();
const urls = pages.map((page) => `  <url><loc>${SITE.url}/${page}</loc></url>`).join('\n');
await Bun.write(
  join(dist, 'sitemap.xml'),
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`,
);

const { index, errors } = await pagefind.createIndex({});
if (!index) throw new Error(`pagefind: ${errors.join(', ')}`);
const indexed = await index.addDirectory({ path: dist });
if (indexed.errors.length > 0) throw new Error(`pagefind: ${indexed.errors.join(', ')}`);
await index.writeFiles({ outputPath: join(dist, 'pagefind') });
await pagefind.close();
// addDirectory counts every HTML file it read; the entry file counts the pages actually indexed (data-pagefind-body).
const entry = await Bun.file(join(dist, 'pagefind/pagefind-entry.json')).json();
const searchable = Object.values(entry.languages as Record<string, { page_count: number }>).reduce(
  (n, l) => n + l.page_count,
  0,
);

console.log(
  `postbuild: ${pages.length} pages + 404.html + sitemap.xml in dist/, ${searchable} pages in the search index`,
);
