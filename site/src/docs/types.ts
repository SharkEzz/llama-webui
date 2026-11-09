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
