import type { MetaDescriptor } from 'react-router';
import { href } from './content.ts';
import { SITE } from './site.ts';

interface PageMeta {
  /** Page title; the site name is appended (the home page passes none). */
  title?: string;
  description?: string;
  /** Route path without basename, e.g. "docs/installation" ("" for home). */
  path: string;
}

/** Title, description, canonical URL and Open Graph tags. React Router keeps only the deepest route's meta. */
export function pageMeta({ title, description = SITE.description, path }: PageMeta): MetaDescriptor[] {
  const fullTitle = title ? `${title} · ${SITE.name}` : `${SITE.name} · ${SITE.tagline}`;
  const url = `${SITE.url}${href(path)}`;
  return [
    { title: fullTitle },
    { name: 'description', content: description },
    { tagName: 'link', rel: 'canonical', href: url },
    { property: 'og:type', content: 'website' },
    { property: 'og:site_name', content: SITE.name },
    { property: 'og:title', content: fullTitle },
    { property: 'og:description', content: description },
    { property: 'og:url', content: url },
    { name: 'twitter:card', content: 'summary_large_image' },
  ];
}
