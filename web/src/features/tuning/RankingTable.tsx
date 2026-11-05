import { useNavigate } from "react-router"
import { Copy, ExternalLink, MoreHorizontal, Star, UserPlus } from "lucide-react"
import { type BenchRun, type BenchStatus, NOISE, type Ranked, rankRuns, type Sweep, sweepCtx } from "@llama-webui/shared"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { formatAccept, vramTotal } from "@/features/bench/format"
import { STATUS_LABEL } from "@/lib/bench"
import { copyText } from "@/lib/clipboard"
import { formatDuration } from "@/lib/format"
import { useTuning } from "@/lib/tuning"
import { cn } from "@/lib/utils"
import { VerdictBadge } from "./PlanTable"
import { RankBars } from "./RankBars"

const BARS = 8
const NOISE_TEXT = `ex æquo avec le premier : écart inférieur au bruit de mesure (pp ±${NOISE.pp * 100} %, tg ±${NOISE.tg * 100} %)`
const nf = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 1 })
const STATUS_VARIANT: Record<BenchStatus, "secondary" | "outline" | "destructive"> = {
  queued: "outline",
  running: "secondary",
  ok: "outline",
  failed: "destructive",
  cancelled: "secondary",
  interrupted: "secondary",
}

/** Le classement d'un sweep : exploration (llama-bench) et validation (serveur) à part, jamais mélangées. */
export function RankingTable({ sweep, runs }: { sweep: Sweep; runs: BenchRun[] }) {
  const ctx = sweepCtx(sweep.spec)
  const explore = rankRuns(
    runs.filter((r) => r.kind === "bench"),
    sweep.spec.preset,
    ctx,
  )
  const validate = rankRuns(
    runs.filter((r) => r.kind === "server"),
    sweep.spec.preset,
    ctx,
  )
  // Le meilleur enregistré, sinon (supprimé depuis Benchmark) celui du classement affiché.
  const bestId = sweep.bestRunId ?? (validate.find((r) => r.rank === 1) ?? explore.find((r) => r.rank === 1))?.run.id ?? null
  const top = explore.filter((r) => r.rank !== null).slice(0, BARS)

  return (
    <div className="flex flex-col gap-6">
      {validate.length > 0 && <Ranking title="Validation (serveur)" ranked={validate} bestId={bestId} server />}
      <Ranking title="Exploration (llama-bench)" ranked={explore} bestId={bestId} />
      {top.length > 1 && (
        <div className="flex flex-col gap-2">
          <RankBars ranked={top} />
          <p className="text-xs text-muted-foreground">
            Meilleures configurations de l'exploration. Trait fin : ± un écart-type. Les configurations dont l'écart avec la première est sous le bruit (pp ±{NOISE.pp * 100} %, tg ±{NOISE.tg * 100} %) sont ex
            æquo (« 1= ») ; llama-bench ne mesure ni MTP ni -c : la validation serveur tranche.
          </p>
        </div>
      )}
    </div>
  )
}

function Ranking({ title, ranked, bestId, server = false }: { title: string; ranked: Ranked[]; bestId: number | null; server?: boolean }) {
  const navigate = useNavigate()
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-sm font-medium">{title}</h3>
      {ranked.length === 0 ? (
        <p className="text-sm text-muted-foreground">Aucun run.</p>
      ) : (
        <Table className="[&_td]:px-1.5 [&_th]:px-1.5">
          <TableHeader>
            <TableRow>
              <TableHead className="w-10">Rang</TableHead>
              <TableHead>Configuration</TableHead>
              <TableHead>Estimé</TableHead>
              <TableHead>Statut</TableHead>
              <TableHead className="text-right">Prompt</TableHead>
              <TableHead className="text-right">Génération</TableHead>
              {server && <TableHead className="text-right">MTP</TableHead>}
              <TableHead className="text-right">VRAM pic</TableHead>
              <TableHead className="text-right">Durée</TableHead>
              <TableHead className="w-8">
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {ranked.map((r) => {
              const best = r.run.id === bestId
              return (
                <TableRow key={r.run.id} className={cn(best && "bg-accent/60 hover:bg-accent")}>
                  <TableCell className="num text-xs">
                    {r.rank === null ? (
                      <span className="text-muted-foreground">—</span>
                    ) : r.tie ? (
                      <Tooltip>
                        <TooltipTrigger render={<span />} className="underline decoration-dotted underline-offset-4">
                          1=
                        </TooltipTrigger>
                        <TooltipContent>{NOISE_TEXT}</TooltipContent>
                      </Tooltip>
                    ) : (
                      r.rank
                    )}
                  </TableCell>
                  <TableCell className="font-mono text-xs whitespace-normal">
                    <span className="flex items-center gap-1.5">
                      {best && <Star className="size-3.5 shrink-0 fill-current text-primary" aria-label="meilleur" />}
                      {r.run.sweepLabel?.replace(/^validation · /, "") ?? `#${r.run.id}`}
                    </span>
                  </TableCell>
                  <TableCell>{r.run.fit ? <VerdictBadge verdict={r.run.fit} /> : <span className="text-muted-foreground">—</span>}</TableCell>
                  <TableCell>
                    <StatusBadge run={r.run} />
                  </TableCell>
                  <Measure m={r.run.pp} />
                  <Measure m={r.run.tg} />
                  {server && <TableCell className="num text-right text-xs">{formatAccept(r.run.draftAcceptPct)}</TableCell>}
                  <TableCell className="num text-right text-xs whitespace-nowrap">{r.run.vramPeak.length ? vramTotal(r.run) : "—"}</TableCell>
                  <TableCell className="num text-right text-xs whitespace-nowrap">{r.run.durationMs === null ? "—" : formatDuration(r.run.durationMs)}</TableCell>
                  <TableCell>
                    <DropdownMenu>
                      <DropdownMenuTrigger render={<Button variant="ghost" size="icon-xs" />} aria-label={`Actions pour ${r.run.sweepLabel ?? r.run.id}`}>
                        <MoreHorizontal />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="min-w-48">
                        <DropdownMenuItem
                          disabled={r.run.status !== "ok"}
                          onClick={async () => {
                            const p = await useTuning.getState().toProfile(r.run.id)
                            if (p) navigate(`/profiles?id=${p.id}`)
                          }}
                        >
                          <UserPlus /> Créer un profil
                        </DropdownMenuItem>
                        <DropdownMenuItem disabled={!r.run.command} onClick={() => void copyText(r.run.command)}>
                          <Copy /> Copier la commande
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => navigate(`/bench?run=${r.run.id}`)}>
                          <ExternalLink /> Voir dans Benchmark
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      )}
    </section>
  )
}

function StatusBadge({ run }: { run: BenchRun }) {
  const oom = run.status === "failed" && run.error?.startsWith("Mémoire insuffisante")
  const badge = <Badge variant={STATUS_VARIANT[run.status]}>{oom ? "mémoire insuffisante" : STATUS_LABEL[run.status]}</Badge>
  if (!run.error) return badge
  return (
    <Tooltip>
      <TooltipTrigger render={<span />}>{badge}</TooltipTrigger>
      <TooltipContent className="max-w-md">{run.error}</TooltipContent>
    </Tooltip>
  )
}

function Measure({ m }: { m: BenchRun["pp"] }) {
  return (
    <TableCell className="num text-right text-xs whitespace-nowrap">
      {m ? nf.format(m.tps) : "—"}
      {m && m.stddev > 0 && <div className="text-[0.7rem] text-muted-foreground">± {nf.format(m.stddev)}</div>}
    </TableCell>
  )
}
