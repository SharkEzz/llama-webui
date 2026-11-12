import { describe, expect, test } from 'vitest';
import { contentRoute, contentRoutes, href } from './content.ts';

describe('contentRoute', () => {
  test('maps a page to its path', () => {
    expect(contentRoute('docs/getting-started/installation.mdx')).toEqual({
      path: 'docs/getting-started/installation',
      file: 'docs/getting-started/installation.mdx',
      section: 'docs',
    });
  });

  test('maps index files to their folder', () => {
    expect(contentRoute('developers/index.mdx')?.path).toBe('developers');
    expect(contentRoute('docs/guides/index.mdx')?.path).toBe('docs/guides');
  });

  test('ignores non-MDX files and files outside a section', () => {
    expect(contentRoute('nav.ts')).toBeNull();
    expect(contentRoute('drafts/page.mdx')).toBeNull();
  });

  test('normalizes Windows separators', () => {
    expect(contentRoute('docs\\a\\b.mdx')?.path).toBe('docs/a/b');
  });
});

test('contentRoutes sorts and filters', () => {
  const routes = contentRoutes(['docs/b.mdx', 'nav.ts', 'developers/index.mdx', 'docs/a.mdx']);
  expect(routes.map((r) => r.path)).toEqual(['developers', 'docs/a', 'docs/b']);
});

test('href always has leading and trailing slashes', () => {
  expect(href('docs/a')).toBe('/docs/a/');
  expect(href('/docs/a/')).toBe('/docs/a/');
  expect(href('')).toBe('/');
});
