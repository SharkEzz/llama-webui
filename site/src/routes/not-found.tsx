import { Link } from 'react-router';
import { SiteFooter } from '@/components/SiteFooter';
import { SiteHeader } from '@/components/SiteHeader';
import { Button } from '@/components/ui/button';
import { SITE } from '@/lib/site';

export const meta = () => [{ title: `Page not found · ${SITE.name}` }, { name: 'robots', content: 'noindex' }];

export default function NotFound() {
  return (
    <>
      <SiteHeader />
      <main className="mx-auto flex max-w-xl flex-col items-center px-6 py-32 text-center">
        <p className="num text-sm text-primary-ink">404</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight">Page not found</h1>
        <p className="mt-4 text-muted-foreground">This page doesn't exist, or it moved.</p>
        <div className="mt-8 flex gap-3">
          <Button nativeButton={false} render={<Link to="/" />}>
            Home
          </Button>
          <Button variant="outline" nativeButton={false} render={<Link to="/docs/" />}>
            Documentation
          </Button>
        </div>
      </main>
      <SiteFooter />
    </>
  );
}
