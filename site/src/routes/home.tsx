import { ArrowRight } from 'lucide-react';
import { Link } from 'react-router';
import { GitHubIcon } from '@/components/GitHubIcon';
import { SiteFooter } from '@/components/SiteFooter';
import { SiteHeader } from '@/components/SiteHeader';
import { Button } from '@/components/ui/button';
import { pageMeta } from '@/lib/meta';
import { SITE } from '@/lib/site';

export const meta = () => pageMeta({ path: '' });

// Placeholder hero: the real landing page is built in milestones M3 and M4.
export default function Home() {
  return (
    <>
      <SiteHeader />
      <main className="relative isolate overflow-hidden">
        <div className="bg-grid absolute inset-0 -z-10" aria-hidden="true" />
        <section className="mx-auto max-w-4xl px-6 py-32 text-center">
          <h1 className="text-5xl font-semibold tracking-tight text-balance sm:text-6xl">
            A local <span className="text-gradient-brand">control room</span> for llama.cpp's llama-server.
          </h1>
          <p className="mx-auto mt-6 max-w-2xl text-lg text-muted-foreground text-pretty">{SITE.description}</p>
          <div className="mt-10 flex justify-center gap-3">
            <Button size="lg" nativeButton={false} render={<Link to="/docs/getting-started/installation/" />}>
              Get started <ArrowRight />
            </Button>
            <Button size="lg" variant="outline" nativeButton={false} render={<a href={SITE.repo} />}>
              <GitHubIcon className="size-4" /> GitHub
            </Button>
          </div>
        </section>
      </main>
      <SiteFooter />
    </>
  );
}
