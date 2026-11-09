/**
 * Build-time plugins for the MDX pages of site/content (wired in vite.config.ts).
 *
 * remarkDocFrontmatter reads the YAML front matter (title and description, both required) and removes it from the
 * page. rehypeDocExports, after rehype-slug, collects the h2/h3 table of contents and prepends to the module:
 *
 *   import { pageMeta } from '@/lib/meta';
 *   export const handle = { doc: { title, description, path, file, toc } };
 *   export const meta = () => pageMeta({ title, description, path });
 *
 * React Router reads `meta`, and the docs layout reads `handle.doc` through useMatches().
 */
import { relative } from 'node:path';
import { parse as parseJs } from 'acorn';
import type { Element, Root as HastRoot } from 'hast';
import { toString as hastToString } from 'hast-util-to-string';
import type { Root as MdastRoot } from 'mdast';
import { visit } from 'unist-util-visit';
import type { VFile } from 'vfile';
import { parse as parseYaml } from 'yaml';
import { contentRoute } from '../lib/content.ts';
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

export function rehypeDocExports(options: { contentDir: string }) {
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
    const doc: DocInfo = { ...fm, path: route.path, file: source, toc };
    const code = [
      "import { pageMeta } from '@/lib/meta';",
      `export const handle = { doc: ${JSON.stringify(doc)} };`,
      'export const meta = () => pageMeta(handle.doc);',
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
