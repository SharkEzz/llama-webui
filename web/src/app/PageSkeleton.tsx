import { Skeleton } from "@/components/ui/skeleton"

/** Le temps de charger le code d'une page (routes chargées à la demande). */
export function PageSkeleton() {
  return (
    // biome-ignore lint/a11y/useAriaPropsSupportedByRole: libellé du squelette de chargement, conservé tel quel
    <div className="flex flex-col gap-6" aria-busy="true" aria-label="Chargement de la page">
      <Skeleton className="h-10 w-48" />
      <Skeleton className="h-64" />
      <Skeleton className="h-64" />
    </div>
  )
}
