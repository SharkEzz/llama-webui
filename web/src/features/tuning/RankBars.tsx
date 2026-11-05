import type { Measure, Ranked } from "@llama-webui/shared"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { formatMeasure } from "@/features/bench/format"

const nf = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 1 })

/**
 * Les meilleures configurations : une seule mesure par barre, donc une seule teinte ; pp et tg sur deux graphes, chacun sur
 * sa propre échelle (pas de double axe). Le trait fin autour de l'extrémité montre ± σ.
 */
export function RankBars({ ranked }: { ranked: Ranked[] }) {
  return (
    <div className="grid gap-6 md:grid-cols-2">
      <Panel title="Génération (tok/s)" ranked={ranked} pick={(r) => r.run.tg} />
      <Panel title="Prompt (tok/s)" ranked={ranked} pick={(r) => r.run.pp} />
    </div>
  )
}

function Panel({ title, ranked, pick }: { title: string; ranked: Ranked[]; pick(r: Ranked): Measure | null }) {
  const max = Math.max(1, ...ranked.map((r) => (pick(r)?.tps ?? 0) + (pick(r)?.stddev ?? 0)))
  const pct = (x: number) => `${Math.max(0, Math.min(100, (x / max) * 100))}%`
  return (
    <figure className="flex flex-col gap-2">
      <figcaption className="text-sm font-medium">{title}</figcaption>
      <div className="flex flex-col gap-0.5">
        {ranked.map((r) => {
          const m = pick(r)
          return (
            <Tooltip key={r.run.id}>
              <TooltipTrigger
                render={<div />}
                tabIndex={0}
                className="grid grid-cols-[2rem_minmax(0,13rem)_minmax(0,1fr)_3.5rem] items-center gap-2 rounded-sm py-1 outline-none hover:bg-muted/60 focus-visible:ring-3 focus-visible:ring-ring/50"
                aria-label={`${r.run.sweepLabel ?? `#${r.run.id}`} : ${formatMeasure(m)}`}
              >
                <span className="num text-xs text-muted-foreground">
                  {r.tie ? "1=" : r.rank}
                </span>
                <span className="truncate font-mono text-xs">{r.run.sweepLabel ?? `#${r.run.id}`}</span>
                <span className="relative h-3">
                  {m && (
                    <>
                      <span className="absolute inset-y-0 left-0 rounded-r-[4px] bg-chart-1" style={{ width: pct(m.tps) }} />
                      {m.stddev > 0 && (
                        <span
                          className="absolute top-1/2 h-px -translate-y-1/2 bg-foreground/70"
                          style={{ left: pct(m.tps - m.stddev), width: `calc(${pct(2 * m.stddev)})` }}
                          aria-hidden="true"
                        />
                      )}
                    </>
                  )}
                </span>
                <span className="num text-right text-xs">{m ? nf.format(m.tps) : "—"}</span>
              </TooltipTrigger>
              <TooltipContent className="num">
                {r.run.sweepLabel} : {formatMeasure(m)}
              </TooltipContent>
            </Tooltip>
          )
        })}
      </div>
    </figure>
  )
}
