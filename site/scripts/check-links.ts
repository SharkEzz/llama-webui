/**
 * Checks every internal link of the built site (dist/, after `pnpm build`): the target page or file exists, page
 * links use the trailing-slash form, and #anchors exist on their page. Exits with 1 and lists the broken links.
 * External links are not fetched.
 */
import { existsSync, globSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { classify, extractLinks, type PageLinks } from './links.ts';

const BASE = '/llama-webui/';
const dist = join(import.meta.dirname, '..', 'dist');

if (!existsSync(join(dist, 'index.html'))) {
  console.error('check-links: dist/index.html not found, run `pnpm build` first');
  process.exit(1);
}

// 404.html is the SPA fallback (an empty shell, rendered in the browser): nothing to check in it.
const files = globSync('**/index.html', { cwd: dist }).sort();
const pages = new Map<string, PageLinks>();
for (const file of files) {
  pages.set(file.replace(/index\.html$/, ''), extractLinks(readFileSync(join(dist, file), 'utf8')));
}

const broken: string[] = [];
let checked = 0;
for (const [page, { urls, ids }] of pages) {
  for (const url of new Set(urls)) {
    const target = classify(url, BASE);
    checked++;
    const fail = (reason: string) => broken.push(`${BASE}${page}: ${url} (${reason})`);
    switch (target.kind) {
      case 'external':
        break;
      case 'error':
        fail(target.reason);
        break;
      case 'anchor':
        if (target.hash && !ids.has(target.hash)) fail('no such anchor on this page');
        break;
      case 'file':
        if (!existsSync(join(dist, target.path))) fail('file not found');
        break;
      case 'page': {
        const linked = pages.get(target.path);
        if (!linked) fail('page not found');
        else if (target.hash && !linked.ids.has(target.hash)) fail(`no #${target.hash} on that page`);
        break;
      }
    }
  }
}

if (broken.length > 0) {
  console.error(`check-links: ${broken.length} broken link(s)\n${broken.map((b) => `  ${b}`).join('\n')}`);
  process.exit(1);
}
console.log(`check-links: ${checked} links on ${pages.size} pages, none broken`);
