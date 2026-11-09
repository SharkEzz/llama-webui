import type { ContentSection } from '../lib/content.ts';

export interface NavPage {
  /** Route path without slashes or basename. */
  path: string;
  /** Label in the sidebar (can be shorter than the page title). */
  title: string;
}

export interface NavGroup {
  title: string;
  pages: NavPage[];
}

export interface NavSection {
  id: ContentSection;
  title: string;
  groups: NavGroup[];
}

export interface NavEntry extends NavPage {
  section: NavSection;
  group: NavGroup;
}

/** Every page of every section, in reading order. */
export function flatten(nav: readonly NavSection[]): NavEntry[] {
  return nav.flatMap((section) =>
    section.groups.flatMap((group) => group.pages.map((page) => ({ ...page, section, group }))),
  );
}

/** "/docs/a/b/" or "docs/a/b" → "docs/a/b". */
export const normalizePath = (pathname: string) => pathname.replace(/^\/+|\/+$/g, '');

/** The section a path belongs to (by its first segment), or null. */
export function sectionOf(nav: readonly NavSection[], pathname: string): NavSection | null {
  const first = normalizePath(pathname).split('/')[0];
  return nav.find((s) => s.id === first) ?? null;
}

/** The page at `pathname` with its neighbours in the same section (no wrap-around between sections). */
export function locate(nav: readonly NavSection[], pathname: string) {
  const path = normalizePath(pathname);
  const all = flatten(nav);
  const i = all.findIndex((e) => e.path === path);
  const current = all[i];
  if (!current) return null;
  const sameSection = (e: NavEntry | undefined) => (e && e.section === current.section ? e : null);
  return { current, prev: sameSection(all[i - 1]), next: sameSection(all[i + 1]) };
}
