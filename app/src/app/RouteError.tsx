import { CircleAlert } from 'lucide-react';
import { isRouteErrorResponse, useRouteError } from 'react-router';
import { AuroraBackground } from '@/components/glass/AuroraBackground';
import { GlassCard } from '@/components/glass/GlassCard';
import { Button } from '@/components/ui/button';
import { errorMessage } from '@/lib/api';

/**
 * What the app shows when a page fails to load or to render (the root route's error boundary): the error and a
 * reload, rather than React Router's default screen. A page's code that is gone after a new build is the usual case.
 */
export function RouteError() {
  const error = useRouteError();
  const message = isRouteErrorResponse(error) ? `${error.status} ${error.statusText}` : errorMessage(error);
  return (
    <>
      <AuroraBackground />
      <main className="mx-auto flex max-w-xl flex-col gap-4 p-4 pt-24">
        <GlassCard icon={CircleAlert} tone="rose" title="This page could not be shown">
          <div className="flex flex-col items-start gap-4">
            <p className="font-mono text-sm break-all text-muted-foreground">{message}</p>
            <Button type="button" onClick={() => window.location.reload()}>
              Reload
            </Button>
          </div>
        </GlassCard>
      </main>
    </>
  );
}
