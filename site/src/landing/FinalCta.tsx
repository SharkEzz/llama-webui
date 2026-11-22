import { ArrowRight } from 'lucide-react';
import { Link } from 'react-router';
import { Button } from '@/components/ui/button';
import { GlassCard } from './GlassCard';

export function FinalCta() {
  return (
    <section aria-labelledby="start-title" className="mx-auto max-w-6xl px-6 py-16 pb-24 sm:py-20 sm:pb-28">
      <GlassCard as="div" className="relative rounded-3xl px-8 py-16 text-center sm:px-12 sm:py-20">
        <div
          className="halo absolute -top-20 left-1/2 -z-10 h-44 w-3/5 -translate-x-1/2 [--halo:var(--tone-blue)]"
          aria-hidden="true"
        />
        <h2
          id="start-title"
          className="mx-auto max-w-[18ch] text-4xl font-semibold tracking-[-0.035em] text-balance sm:text-5xl"
        >
          Run it on your machine.
        </h2>
        <p className="mx-auto mt-4 max-w-[54ch] text-lg text-muted-foreground text-pretty">
          Install a release with npm, start it and open port 7860. A setup checklist takes it from there.
        </p>
        <div className="mt-9 flex flex-wrap justify-center gap-3">
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
            render={<Link to="/developers/" />}
          >
            Read the developer docs
          </Button>
        </div>
      </GlassCard>
    </section>
  );
}
