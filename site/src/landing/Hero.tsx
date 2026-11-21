import { ArrowRight } from 'lucide-react';
import { Link } from 'react-router';
import { GitHubIcon } from '@/components/GitHubIcon';
import { Button } from '@/components/ui/button';
import { SITE } from '@/lib/site';
import { LiveDashboard } from './LiveDashboard';

export function Hero() {
  return (
    <section className="relative isolate overflow-clip pb-20 sm:pb-24">
      <div className="mx-auto flex max-w-5xl flex-col items-center px-6 pt-16 text-center sm:pt-24">
        <div className="inline-flex items-center gap-2 rounded-full border border-surface-border-bright bg-card/75 px-3.5 py-1.5 text-xs font-medium text-muted-foreground shadow-surface inset-shadow-highlight backdrop-blur-xl">
          <span className="size-2 rounded-full bg-success shadow-[0_0_10px] shadow-success/80" aria-hidden="true" />
          <span>Free &amp; open source · MIT</span>
          <span className="text-border" aria-hidden="true">
            |
          </span>
          <span className="text-foreground">Linux · Single Node.js process</span>
        </div>

        <h1 className="text-gradient-fade mt-6 max-w-[15ch] text-5xl leading-[1.02] font-semibold tracking-[-0.04em] text-balance sm:text-7xl">
          {SITE.tagline}
        </h1>

        <p className="mt-6 max-w-[60ch] text-lg leading-relaxed text-muted-foreground text-pretty sm:text-xl">
          {SITE.description}
        </p>

        <div className="mt-9 flex flex-wrap items-center justify-center gap-3">
          <Button
            size="lg"
            className="h-11 rounded-xl px-5 shadow-[0_10px_28px_-6px] shadow-primary/55 inset-shadow-highlight"
            nativeButton={false}
            render={<Link to="/docs/getting-started/installation/" />}
          >
            Get started
            <ArrowRight className="size-4" aria-hidden="true" />
          </Button>
          <Button
            size="lg"
            variant="outline"
            className="h-11 rounded-xl border-surface-border-bright bg-card/70 px-5 backdrop-blur-xl hover:bg-surface-strong"
            nativeButton={false}
            render={<a href={SITE.repo} />}
          >
            <GitHubIcon className="size-4" />
            GitHub
          </Button>
        </div>

        <p className="mt-5 text-xs text-faint-foreground sm:text-sm">
          Runs on port 7860 · Embedded SQLite · No external daemons
        </p>
      </div>

      <div className="mx-auto mt-14 max-w-7xl px-4 sm:mt-16 sm:px-6">
        <LiveDashboard />
      </div>
    </section>
  );
}
