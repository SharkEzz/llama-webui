import { describe, expect, test } from 'bun:test';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { NAV } from '../../content/nav.ts';
import { contentRoutes } from '../lib/content.ts';
import { flatten, locate, type NavSection, sectionOf } from './nav.ts';

const contentDir = fileURLToPath(new URL('../../content', import.meta.url));
const pages = contentRoutes(readdirSync(contentDir, { recursive: true, encoding: 'utf8' }));

describe('content/nav.ts', () => {
  const entries = flatten(NAV);

  test('lists every page under content/', () => {
    const listed = new Set(entries.map((e) => e.path));
    expect(pages.map((p) => p.path).filter((p) => !listed.has(p))).toEqual([]);
  });

  test('has a file for every entry, listed once', () => {
    const files = new Set(pages.map((p) => p.path));
    expect(entries.map((e) => e.path).filter((p) => !files.has(p))).toEqual([]);
    expect(new Set(entries.map((e) => e.path)).size).toBe(entries.length);
  });

  test('keeps each page in the section of its folder', () => {
    for (const e of entries) expect(e.path.split('/')[0]).toBe(e.section.id);
  });
});

describe('nav helpers', () => {
  const nav: NavSection[] = [
    {
      id: 'docs',
      title: 'Docs',
      groups: [
        { title: 'A', pages: [{ path: 'docs', title: 'Overview' }] },
        { title: 'B', pages: [{ path: 'docs/b', title: 'B' }] },
      ],
    },
    { id: 'developers', title: 'Dev', groups: [{ title: 'C', pages: [{ path: 'developers', title: 'Dev' }] }] },
  ];

  test('locate finds neighbours across groups, not across sections', () => {
    const b = locate(nav, '/docs/b/');
    expect(b?.prev?.path).toBe('docs');
    expect(b?.next).toBeNull();
    expect(locate(nav, 'developers')?.prev).toBeNull();
    expect(locate(nav, '/docs/missing/')).toBeNull();
  });

  test('sectionOf reads the first segment', () => {
    expect(sectionOf(nav, '/developers/api/')?.id).toBe('developers');
    expect(sectionOf(nav, '/')).toBeNull();
  });
});
