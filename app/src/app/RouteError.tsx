import { CircleAlert } from 'lucide-react';
import { isRouteErrorResponse, useRouteError } from 'react-router';
import { AuroraBackground } from '@/components/glass/AuroraBackground';
import { GLASS } from '@/components/glass/glass';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { errorMessage } from '@/lib/api';

/**
 * What the app shows when a page fails to load or to render (the root route's error boundary): the error, in the
 * app's destructive alert, and a reload, rather than React Router's default screen. A page's code that is gone after a
 * new build is the usual case.
 */
export function RouteError() {
  const error = useRouteError();
  const message = isRouteErrorResponse(error) ? `${error.status} ${error.statusText}` : errorMessage(error);
  return (
    <>
      <AuroraBackground />
      <main className="mx-auto flex max-w-xl flex-col items-start gap-4 p-4 pt-24">
        <Alert variant="destructive" className={GLASS}>
          <CircleAlert />
          <AlertTitle>This page could not be shown</AlertTitle>
          <AlertDescription className="font-mono break-all">{message}</AlertDescription>
        </Alert>
        <Button type="button" onClick={() => window.location.reload()}>
          Reload
        </Button>
      </main>
    </>
  );
}
