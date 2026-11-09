/**
 * Build-time plugins for the MDX pages of site/content (wired in vite.config.ts).
 *
 * remarkDocFrontmatter reads the YAML front matter (title and description, both required) and removes it from the
 * page. rehypeDocExports, after rehype-slug, collects the h2/h3 table of contents and prepends to the module:
 *
 *   import { pageMeta } from '@/lib/meta';
 *   export const handle = { doc: { title, metaTitle, description, path, file, toc } };
 *   export const meta = () => pageMeta({ title: metaTitle, description, path });
 *
 * React Router reads `meta`, and the docs layout reads `handle.doc` through useMatches().
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parse as parseJs } from 'acorn';
import type { Element, Root as HastRoot } from 'hast';
import { toString as hastToString } from 'hast-util-to-string';
import type { Root as MdastRoot } from 'mdast';
import { visit } from 'unist-util-visit';
import type { VFile } from 'vfile';
import { parse as parseYaml } from 'yaml';
import { NAV } from '../../content/nav.ts';
import { contentRoute } from '../lib/content.ts';
import { flatten } from './nav.ts';
import type { DocInfo, TocItem } from './types.ts';

interface Frontmatter {
  title: string;
  description: string;
}

export function remarkDocFrontmatter() {
  return (tree: MdastRoot, file: VFile) => {
    const index = tree.children.findIndex((n) => n.type === 'yaml');
    const node = tree.children[index];
    const data = node && 'value' in node ? (parseYaml(node.value) as Partial<Frontmatter> | null) : null;
    if (!data?.title || !data.description) {
      file.fail('Front matter needs a title and a description (--- title: … description: … ---)');
    }
    tree.children.splice(index, 1);
    file.data.frontmatter = { title: data.title, description: data.description };
  };
}

/** How many pages use each front matter title (read once per build: titles shared by several pages get a suffix). */
function titleCounts(contentDir: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const f of readdirSync(contentDir, { recursive: true, encoding: 'utf8' })) {
    if (!f.endsWith('.mdx')) continue;
    const fm = /^---\n([\s\S]*?)\n---/.exec(readFileSync(join(contentDir, f), 'utf8'))?.[1];
    const title = fm ? (parseYaml(fm) as Partial<Frontmatter> | null)?.title : undefined;
    if (title) counts.set(title, (counts.get(title) ?? 0) + 1);
  }
  return counts;
}

export function rehypeDocExports(options: { contentDir: string }) {
  const counts = titleCounts(options.contentDir);
  const groups = new Map(flatten(NAV).map((e) => [e.path, e]));
  return (tree: HastRoot, file: VFile) => {
    const toc: TocItem[] = [];
    visit(tree, 'element', (node: Element) => {
      if ((node.tagName === 'h2' || node.tagName === 'h3') && typeof node.properties.id === 'string') {
        toc.push({ id: node.properties.id, text: hastToString(node), depth: node.tagName === 'h2' ? 2 : 3 });
      }
    });
    const fm = file.data.frontmatter as Frontmatter;
    const source = relative(options.contentDir, file.path).replaceAll('\\', '/');
    const route = contentRoute(source);
    if (!route) return file.fail(`Not a docs page: ${source}`);
    const entry = groups.get(route.path);
    const shared = (counts.get(fm.title) ?? 0) > 1;
    const metaTitle =
      shared && route.section === 'developers' && entry ? `${fm.title} · ${entry.group.title}` : fm.title;
    const doc: DocInfo = { ...fm, metaTitle, path: route.path, file: source, toc };
    const code = [
      "import { pageMeta } from '@/lib/meta';",
      `export const handle = { doc: ${JSON.stringify(doc)} };`,
      'export const meta = () => pageMeta({ ...handle.doc, title: handle.doc.metaTitle });',
    ].join('\n');
    const estree = parseJs(code, { ecmaVersion: 'latest', sourceType: 'module' });
    // mdxjsEsm nodes come from the MDX syntax tree types, which this hast Root does not list.
    tree.children.unshift({ type: 'mdxjsEsm', value: code, data: { estree } } as never);
  };
}

/** Shiki transformer: `title="…"` in a code fence's meta becomes data-title on the <pre>, with the language. */
export const codeMeta = {
  name: 'llama-webui:code-meta',
  pre(this: { options: { lang?: string; meta?: { __raw?: string } } }, node: Element) {
    const title = /title="([^"]+)"/.exec(this.options.meta?.__raw ?? '')?.[1];
    if (title) node.properties['data-title'] = title;
    if (this.options.lang) node.properties['data-language'] = this.options.lang;
  },
};
