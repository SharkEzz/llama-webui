import { Link } from 'react-router';
import { GitHubIcon } from '@/components/GitHubIcon';
import { Button } from '@/components/ui/button';
import { SITE } from '@/lib/site';
import { LiveDashboard } from './LiveDashboard';

export function Hero() {
  return (
    <section className="relative isolate overflow-clip pb-24">
      <div className="bg-grid absolute inset-0 -z-20" aria-hidden="true" />
      <div className="mx-auto max-w-6xl px-6 pt-20 sm:pt-28">
        <h1 className="text-gradient-fade max-w-[14ch] text-5xl leading-[1.02] font-semibold tracking-[-0.035em] text-balance sm:text-7xl">
          {SITE.tagline}
        </h1>
        <p className="mt-6 max-w-[58ch] text-lg text-muted-foreground text-pretty sm:text-xl">{SITE.description}</p>
        <div className="mt-10 flex flex-wrap items-center gap-3">
          <Button size="lg" nativeButton={false} render={<Link to="/docs/getting-started/installation/" />}>
            Get started
          </Button>
          <Button size="lg" variant="outline" nativeButton={false} render={<a href={SITE.repo} />}>
            <GitHubIcon className="size-4" />
            GitHub
          </Button>
        </div>
        <p className="mt-5 text-sm text-muted-foreground">
          Free and open source under the MIT license. Runs on Linux, on Node.js.
        </p>
      </div>
      <div className="mx-auto mt-16 max-w-7xl px-4 sm:mt-20 sm:px-6">
        <LiveDashboard />
      </div>
    </section>
  );
}
