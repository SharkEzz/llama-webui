/**
 * Pure helpers of scripts/check-links.ts (unit tested): what a built page links to and which anchors it defines.
 */

export interface PageLinks {
  /** href and src values, plus every URL of srcset attributes. */
  urls: string[];
  /** id attributes: the anchors a link can point to. */
  ids: Set<string>;
}

const decode = (v: string) => v.replaceAll('&amp;', '&').replaceAll('&quot;', '"').replaceAll('&#x27;', "'");

export function extractLinks(html: string): PageLinks {
  const urls: string[] = [];
  for (const m of html.matchAll(/\s(?:href|src)="([^"]*)"/g)) urls.push(decode(m[1]!));
  for (const m of html.matchAll(/\ssrcset="([^"]*)"/gi)) {
    for (const part of decode(m[1]!).split(',')) {
      const url = part.trim().split(/\s+/)[0];
      if (url) urls.push(url);
    }
  }
  const ids = new Set([...html.matchAll(/\sid="([^"]*)"/g)].map((m) => decode(m[1]!)));
  return { urls, ids };
}

export type Target =
  | { kind: 'external' }
  | { kind: 'anchor'; hash: string }
  | { kind: 'page'; path: string; hash: string }
  | { kind: 'file'; path: string }
  | { kind: 'error'; reason: string };

/**
 * Classifies a URL found on a page of the site served under `base` ("/llama-webui/"). Pages must use the trailing-slash
 * form ("/llama-webui/docs/x/"), as GitHub Pages would otherwise answer with a redirect.
 */
export function classify(url: string, base: string): Target {
  if (/^(https?:|mailto:|data:|blob:)/.test(url) || url.startsWith('//')) return { kind: 'external' };
  if (url.startsWith('#')) return { kind: 'anchor', hash: decodeURIComponent(url.slice(1)) };
  if (!url.startsWith('/')) return { kind: 'error', reason: 'relative URL (use an absolute path)' };
  if (url !== base.slice(0, -1) && !url.startsWith(base)) return { kind: 'error', reason: `outside ${base}` };
  const [pathAndQuery = '', hash = ''] = url.split('#');
  const path = decodeURIComponent(pathAndQuery.split('?')[0]!.slice(base.length));
  if (path === '' || path.endsWith('/')) return { kind: 'page', path, hash: decodeURIComponent(hash) };
  if (/\.[a-z0-9]+$/i.test(path)) return { kind: 'file', path };
  return { kind: 'error', reason: 'page link without its trailing slash' };
}
