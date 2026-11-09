/**
 * Maps MDX files under content/ to site routes. Pure (no fs) so it can be unit tested with bun test;
 * src/routes.ts feeds it the file list.
 */

export type ContentSection = 'docs' | 'developers';

export interface ContentRoute {
  /** URL path without leading or trailing slash, e.g. "docs/getting-started/installation". */
  path: string;
  /** File path relative to content/, with forward slashes, e.g. "docs/getting-started/installation.mdx". */
  file: string;
  section: ContentSection;
}

const SECTIONS: readonly ContentSection[] = ['docs', 'developers'];

/** "docs/a/index.mdx" -> "docs/a", "docs/a/b.mdx" -> "docs/a/b". Returns null for files outside a section. */
export function contentRoute(file: string): ContentRoute | null {
  const normalized = file.replaceAll('\\', '/');
  if (!normalized.endsWith('.mdx')) return null;
  const section = SECTIONS.find((s) => normalized.startsWith(`${s}/`));
  if (!section) return null;
  const path = normalized.replace(/\.mdx$/, '').replace(/(^|\/)index$/, '');
  return { path, file: normalized, section };
}

/** Sorted, de-duplicated routes for a list of content files (non-MDX files are ignored). */
export function contentRoutes(files: readonly string[]): ContentRoute[] {
  const routes = files.map(contentRoute).filter((r): r is ContentRoute => r !== null);
  return routes.sort((a, b) => a.path.localeCompare(b.path));
}

/** Canonical URL form used everywhere on the site: leading and trailing slash ("/docs/x/"). */
export function href(path: string): string {
  const trimmed = path.replace(/^\/+|\/+$/g, '');
  return trimmed === '' ? '/' : `/${trimmed}/`;
}
