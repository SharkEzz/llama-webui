import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { formatPct } from '@/lib/format';

/** Une case par cœur logique ; l'intensité de --chart-1 suit la charge. Chaque case est un bouton : le tooltip s'ouvre aussi au clavier. */
export function CoreHeatmap({ cores }: { cores: number[] }) {
  return (
    <ul className="grid grid-cols-[repeat(auto-fill,minmax(2.75rem,1fr))] gap-1" aria-label="Charge par cœur">
      {cores.map((pct, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: une case par cœur, l'index est l'identité du cœur
        <li key={i}>
          <Tooltip>
            <TooltipTrigger
              className="flex h-9 w-full items-center justify-center rounded-md border border-border text-[0.65rem] text-muted-foreground outline-none num focus-visible:ring-3 focus-visible:ring-ring/50"
              style={{
                backgroundColor: `color-mix(in oklch, var(--chart-1) ${Math.round(Math.min(100, Math.max(0, pct)))}%, transparent)`,
              }}
              aria-label={`Cœur ${i} : ${formatPct(pct)}`}
            >
              {i}
            </TooltipTrigger>
            <TooltipContent>
              Cœur {i} : {formatPct(pct)}
            </TooltipContent>
          </Tooltip>
        </li>
      ))}
    </ul>
  );
}
