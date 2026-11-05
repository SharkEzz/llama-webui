import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { formatPct } from "@/lib/format"

/** Une case par cœur logique ; l'intensité de --chart-1 suit la charge. */
export function CoreHeatmap({ cores }: { cores: number[] }) {
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(2.75rem,1fr))] gap-1" role="list" aria-label="Charge par cœur">
      {cores.map((pct, i) => (
        <Tooltip key={i}>
          <TooltipTrigger
            render={<div role="listitem" />}
            className="flex h-9 items-center justify-center rounded-md border border-border text-[0.65rem] text-muted-foreground num"
            style={{ backgroundColor: `color-mix(in oklch, var(--chart-1) ${Math.round(Math.min(100, Math.max(0, pct)))}%, transparent)` }}
            aria-label={`Cœur ${i} : ${formatPct(pct)}`}
          >
            {i}
          </TooltipTrigger>
          <TooltipContent>
            Cœur {i} : {formatPct(pct)}
          </TooltipContent>
        </Tooltip>
      ))}
    </div>
  )
}
