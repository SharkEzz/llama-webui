import { describe, expect, test } from 'vitest';
import { classify, extractLinks } from './links.ts';

const BASE = '/llama-webui/';

describe('extractLinks', () => {
  test('reads href, src, every srcset candidate and ids', () => {
    const { urls, ids } = extractLinks(
      '<a href="/llama-webui/docs/?a=1&amp;b=2">x</a><img src="/a.webp" srcset="/b.webp 800w, /c.webp 1600w"><h2 id="setup">',
    );
    expect(urls).toEqual(['/llama-webui/docs/?a=1&b=2', '/a.webp', '/b.webp', '/c.webp']);
    expect([...ids]).toEqual(['setup']);
  });
});

describe('classify', () => {
  test('pages, anchors, files and external links', () => {
    expect(classify('https://github.com/x', BASE)).toEqual({ kind: 'external' });
    expect(classify('#install', BASE)).toEqual({ kind: 'anchor', hash: 'install' });
    expect(classify('/llama-webui/', BASE)).toEqual({ kind: 'page', path: '', hash: '' });
    expect(classify('/llama-webui/docs/a/#b', BASE)).toEqual({ kind: 'page', path: 'docs/a/', hash: 'b' });
    expect(classify('/llama-webui/assets/x.js', BASE)).toEqual({ kind: 'file', path: 'assets/x.js' });
  });

  test('rejects pages without a trailing slash and URLs outside the base', () => {
    expect(classify('/llama-webui/docs/a', BASE).kind).toBe('error');
    expect(classify('/docs/a/', BASE).kind).toBe('error');
    expect(classify('docs/a/', BASE).kind).toBe('error');
  });
});
