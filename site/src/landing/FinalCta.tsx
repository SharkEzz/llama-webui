import { Link } from 'react-router';
import { Button } from '@/components/ui/button';

export function FinalCta() {
  return (
    <section aria-labelledby="start-title" className="relative isolate overflow-clip">
      <div className="bg-grid absolute inset-0 -z-10 rotate-180" aria-hidden="true" />
      <div className="mx-auto max-w-6xl px-6 py-24 sm:py-32">
        <h2
          id="start-title"
          className="max-w-[18ch] text-4xl font-semibold tracking-[-0.03em] text-balance sm:text-5xl"
        >
          Run it on your machine.
        </h2>
        <p className="mt-5 max-w-[56ch] text-lg text-muted-foreground text-pretty">
          Clone the repository, install with Bun and open port 7860. A setup checklist takes it from there.
        </p>
        <div className="mt-10 flex flex-wrap gap-3">
          <Button size="lg" nativeButton={false} render={<Link to="/docs/getting-started/installation/" />}>
            Get started
          </Button>
          <Button size="lg" variant="outline" nativeButton={false} render={<Link to="/developers/" />}>
            Read the developer docs
          </Button>
        </div>
      </div>
    </section>
  );
}
