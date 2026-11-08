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

/** Rendered by scripts/og.ts. */
const OG_IMAGE = { url: `${SITE.url}/og.png`, width: 1200, height: 630, alt: `${SITE.name}: ${SITE.tagline}` };

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
    { property: 'og:image', content: OG_IMAGE.url },
    { property: 'og:image:width', content: String(OG_IMAGE.width) },
    { property: 'og:image:height', content: String(OG_IMAGE.height) },
    { property: 'og:image:alt', content: OG_IMAGE.alt },
    { name: 'twitter:card', content: 'summary_large_image' },
    { name: 'twitter:image', content: OG_IMAGE.url },
  ];
}
