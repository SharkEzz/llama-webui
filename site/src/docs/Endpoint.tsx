import { cn } from '@/lib/utils';

const METHOD: Record<string, string> = {
  GET: 'bg-tone-teal/12 text-tone-teal',
  POST: 'bg-tone-blue/12 text-tone-blue',
  PUT: 'bg-tone-amber/14 text-tone-amber',
  PATCH: 'bg-tone-amber/14 text-tone-amber',
  DELETE: 'bg-tone-rose/12 text-tone-rose',
  WS: 'bg-muted text-foreground',
};

/**
 * The method and path of an API route, placed under the heading that names it:
 * ### List profiles
 * <Endpoint method="GET" path="/api/profiles/:id" />
 * Path parameters (":id") are highlighted.
 */
export function Endpoint({
  method,
  path,
}: {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'WS';
  path: string;
}) {
  const parts = path.split(/(:[A-Za-z]+)/);
  return (
    <div className="not-prose my-4 flex min-w-0 items-center gap-3 rounded-lg bg-well px-3 py-2 font-mono text-[0.8125rem] inset-shadow-well ring-1 ring-border">
      <span className={cn('shrink-0 rounded-md px-1.5 py-0.5 text-[0.6875rem] font-semibold', METHOD[method])}>
        {method}
      </span>
      <code className="min-w-0 break-all text-foreground">
        {parts.map((p, i) =>
          p.startsWith(':') ? (
            // biome-ignore lint/suspicious/noArrayIndexKey: static fragments of one path
            <span key={i} className="text-primary-ink">
              {p}
            </span>
          ) : (
            p
          ),
        )}
      </code>
    </div>
  );
}
