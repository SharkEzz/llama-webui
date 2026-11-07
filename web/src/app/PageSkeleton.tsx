import { Skeleton } from '@/components/ui/skeleton';

/** Le temps de charger le code d'une page (routes chargées à la demande). */
export function PageSkeleton() {
  return (
    <div className="flex flex-col gap-6" role="status" aria-busy="true" aria-label="Chargement de la page">
      <Skeleton className="h-10 w-48" />
      <Skeleton className="h-64" />
      <Skeleton className="h-64" />
    </div>
  );
}
