import { Skeleton } from '@/components/ui/skeleton';

/** While a page's code loads (routes are loaded on demand). */
export function PageSkeleton() {
  return (
    <div className="flex flex-col gap-4" role="status" aria-busy="true" aria-label="Loading page">
      <Skeleton className="h-10 w-48" />
      <Skeleton className="h-64" />
      <Skeleton className="h-64" />
    </div>
  );
}
