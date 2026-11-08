/**
 * Sidebar of both documentation sections, in reading order. Every .mdx file under content/ must appear here exactly
 * once, and every entry must have its file (src/docs/nav.test.ts). Paths are routes: "docs/getting-started/installation"
 * for docs/getting-started/installation.mdx, "docs" for docs/index.mdx.
 */
import type { NavSection } from '../src/docs/nav.ts';

export const NAV: NavSection[] = [
  {
    id: 'docs',
    title: 'Documentation',
    groups: [
      {
        title: 'Getting started',
        pages: [
          { path: 'docs', title: 'Overview' },
          { path: 'docs/getting-started/installation', title: 'Installation' },
        ],
      },
    ],
  },
  {
    id: 'developers',
    title: 'Developers',
    groups: [
      {
        title: 'Overview',
        pages: [{ path: 'developers', title: 'Overview' }],
      },
    ],
  },
];
