import { cn } from "@/lib/utils"
import { TONE_VAR, type Tone } from "./tones"

interface StatTileProps {
  label: string
  value: string | number
  unit?: string
  hint?: string
  tone?: Tone
  className?: string
}

/** Tuile chiffre : libellé, valeur en mono tabulaire, unité et indice optionnels. */
export function StatTile({ label, value, unit, hint, tone = "violet", className }: StatTileProps) {
  return (
    <div className={cn("glass flex min-w-0 flex-col gap-2 rounded-md p-4", className)}>
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <span className="size-1.5 shrink-0 rounded-full" style={{ background: TONE_VAR[tone] }} aria-hidden="true" />
        <span className="truncate">{label}</span>
      </div>
      <div className="flex items-baseline gap-1.5">
        <span className="num truncate text-2xl font-medium leading-none tracking-tight">{value}</span>
        {unit && <span className="text-sm text-muted-foreground">{unit}</span>}
      </div>
      {hint && <p className="truncate text-xs text-muted-foreground">{hint}</p>}
    </div>
  )
}
