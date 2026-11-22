/** A heading of the page's table of contents (h2 and h3). */
export interface TocItem {
  id: string;
  text: string;
  depth: 2 | 3;
}

/** What every MDX page exports as `handle.doc` (src/docs/mdx-plugins.ts), read by the docs layout. */
export interface DocInfo {
  title: string;
  /**
   * Title for <title>, Open Graph and search results: the page title, followed by its sidebar group when a developer
   * page shares its title with another page ("Tuning · API reference" next to the user page "Tuning").
   */
  metaTitle: string;
  description: string;
  /** Route path without slashes or basename: "docs/getting-started/installation". */
  path: string;
  /** Source file, relative to site/content: "docs/getting-started/installation.mdx". */
  file: string;
  toc: TocItem[];
}

export interface DocHandle {
  doc: DocInfo;
}

/** A field of `v`, read as it is written; undefined when `v` is not an object. */
const field = (v: unknown, key: string): unknown =>
  typeof v === 'object' && v !== null ? Reflect.get(v, key) : undefined;

const isTocItem = (v: unknown): v is TocItem =>
  typeof field(v, 'id') === 'string' &&
  typeof field(v, 'text') === 'string' &&
  (field(v, 'depth') === 2 || field(v, 'depth') === 3);

/** `v` is a page's `DocInfo`: what `rehypeDocExports` writes. */
function isDocInfo(v: unknown): v is DocInfo {
  const text = (key: keyof DocInfo) => typeof field(v, key) === 'string';
  const toc = field(v, 'toc');
  return (
    text('title') &&
    text('metaTitle') &&
    text('description') &&
    text('path') &&
    text('file') &&
    Array.isArray(toc) &&
    toc.every(isTocItem)
  );
}

/** The `doc` of a route's `handle` when it is a page's (`DocHandle`), else undefined. */
export function docOf(handle: unknown): DocInfo | undefined {
  const doc = field(handle, 'doc');
  return isDocInfo(doc) ? doc : undefined;
}
