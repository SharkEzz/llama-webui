import { MDXProvider } from '@mdx-js/react';
import { ChevronLeft, ChevronRight, Menu, SquarePen } from 'lucide-react';
import { useState } from 'react';
import { Link, Outlet, useLocation, useMatches } from 'react-router';
import { SiteFooter } from '@/components/SiteFooter';
import { SiteHeader } from '@/components/SiteHeader';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { DocsNav } from '@/docs/DocsNav';
import { mdxComponents } from '@/docs/mdx-components';
import { locate } from '@/docs/nav';
import { Toc } from '@/docs/Toc';
import type { DocHandle } from '@/docs/types';
import { href } from '@/lib/content';
import { SITE } from '@/lib/site';
import { NAV } from '../../content/nav';

/** Documentation shell: section sidebar, the page (title, description, MDX), prev/next, edit link, table of contents. */
export default function DocsLayout() {
  const { pathname } = useLocation();
  const doc = (useMatches().at(-1)?.handle as DocHandle | undefined)?.doc;
  const place = locate(NAV, pathname);
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <MDXProvider components={mdxComponents}>
      <SiteHeader />
      <div className="sticky top-14 z-30 border-b border-border/60 bg-background/80 px-4 py-2 backdrop-blur-xl sm:px-6 lg:hidden">
        <Sheet open={menuOpen} onOpenChange={setMenuOpen}>
          <SheetTrigger render={<Button variant="ghost" size="sm" className="-ml-2 gap-2" />}>
            <Menu />
            {place ? `${place.current.group.title}: ${place.current.title}` : 'Menu'}
          </SheetTrigger>
          <SheetContent side="left" className="w-80 overflow-y-auto">
            <SheetHeader>
              <SheetTitle>{place?.current.section.title ?? 'Documentation'}</SheetTitle>
            </SheetHeader>
            <div className="px-1 pb-6">
              <DocsNav pathname={pathname} onNavigate={() => setMenuOpen(false)} />
            </div>
          </SheetContent>
        </Sheet>
      </div>

      <div className="mx-auto flex max-w-7xl gap-10 px-4 sm:px-6">
        <div className="hidden w-60 shrink-0 lg:block">
          <div className="sticky top-14 max-h-[calc(100dvh-3.5rem)] overflow-y-auto py-10 pr-2">
            <DocsNav pathname={pathname} />
          </div>
        </div>

        <main className="min-w-0 flex-1 py-10 lg:py-12">
          <article data-pagefind-body className="mx-auto max-w-[46rem]">
            {doc && (
              <header className="mb-10">
                {place && <p className="mb-3 text-sm font-medium text-primary-ink">{place.current.group.title}</p>}
                <h1 className="text-4xl font-semibold tracking-[-0.025em] text-balance">{doc.title}</h1>
                <p className="mt-4 text-lg text-muted-foreground text-pretty">{doc.description}</p>
              </header>
            )}
            <div className="docs-prose">
              <Outlet />
            </div>
          </article>

          <div className="mx-auto mt-16 max-w-[46rem]">
            {doc && (
              <a
                href={`${SITE.repo}/edit/master/site/content/${doc.file}`}
                className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
              >
                <SquarePen className="size-4" aria-hidden="true" />
                Edit this page on GitHub
              </a>
            )}
            {place && (place.prev || place.next) && (
              <nav
                aria-label="Previous and next pages"
                className="mt-8 grid gap-4 border-t border-border pt-8 sm:grid-cols-2"
              >
                {place.prev ? (
                  <PageLink to={place.prev.path} label="Previous" title={place.prev.title} dir="prev" />
                ) : (
                  <span />
                )}
                {place.next && <PageLink to={place.next.path} label="Next" title={place.next.title} dir="next" />}
              </nav>
            )}
          </div>
        </main>

        <div className="hidden w-56 shrink-0 xl:block">
          <div className="sticky top-14 max-h-[calc(100dvh-3.5rem)] overflow-y-auto py-12">
            {doc && <Toc key={doc.path} items={doc.toc} />}
          </div>
        </div>
      </div>
      <SiteFooter />
    </MDXProvider>
  );
}

function PageLink({ to, label, title, dir }: { to: string; label: string; title: string; dir: 'prev' | 'next' }) {
  const Icon = dir === 'prev' ? ChevronLeft : ChevronRight;
  return (
    <Link
      to={href(to)}
      className={`group flex flex-col gap-1 rounded-xl border border-border px-4 py-3 transition-colors hover:bg-muted/50 ${dir === 'next' ? 'items-end text-right sm:col-start-2' : ''}`}
    >
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="flex items-center gap-1 font-medium">
        {dir === 'prev' && <Icon className="size-4 text-muted-foreground" aria-hidden="true" />}
        {title}
        {dir === 'next' && <Icon className="size-4 text-muted-foreground" aria-hidden="true" />}
      </span>
    </Link>
  );
}
