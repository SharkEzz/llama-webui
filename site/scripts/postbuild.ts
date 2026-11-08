/**
 * Turns React Router's build output into the folder deployed to GitHub Pages (dist/).
 *
 * With basename "/llama-webui/", React Router writes prerendered pages under build/client/llama-webui/ and the SPA
 * fallback at build/client/index.html, while GitHub Pages already serves the artifact under /llama-webui/. So:
 *   - build/client/llama-webui/**  -> dist/**       (prerendered pages)
 *   - build/client/index.html      -> dist/404.html (SPA fallback: hydrates any unknown URL into the 404 route)
 *   - everything else (assets/, favicon…) is copied as is; build/client/.vite is dropped.
 * Then writes dist/sitemap.xml with trailing-slash URLs.
 */
import { cpSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { join, relative } from 'node:path';
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

console.log(`postbuild: ${pages.length} pages + 404.html + sitemap.xml in dist/`);
