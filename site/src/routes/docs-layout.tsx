import { MDXProvider } from '@mdx-js/react';
import { Outlet } from 'react-router';
import { SiteFooter } from '@/components/SiteFooter';
import { SiteHeader } from '@/components/SiteHeader';
import { mdxComponents } from '@/docs/mdx-components';

// Minimal shell; the sidebar, table of contents, prose styles and search come with the docs engine (M5).
export default function DocsLayout() {
  return (
    <MDXProvider components={mdxComponents}>
      <SiteHeader />
      <main className="mx-auto max-w-3xl px-6 py-16">
        <article data-pagefind-body>
          <Outlet />
        </article>
      </main>
      <SiteFooter />
    </MDXProvider>
  );
}
