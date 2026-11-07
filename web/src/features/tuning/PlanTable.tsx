import type { FitVerdict } from "@llama-webui/shared"
import { CircleAlert, CircleCheck, Play, TriangleAlert } from "lucide-react"
import { useState } from "react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { formatBytes, formatDuration } from "@/lib/format"
import { useServer } from "@/lib/server"
import { useTuning } from "@/lib/tuning"
import { cn } from "@/lib/utils"
import { StopServerDialog } from "./StopServerDialog"

const SHOWN = 100
const LONG_SECONDS = 3600

export const VERDICT: Record<FitVerdict, { label: string; className: string; icon: typeof CircleCheck }> = {
  fits: { label: "tient", className: "bg-success/15 text-success", icon: CircleCheck },
  tight: { label: "limite", className: "bg-warning/15 text-warning", icon: TriangleAlert },
  no: {
    label: "ne tient pas",
    className: "bg-destructive/10 text-destructive dark:bg-destructive/20",
    icon: CircleAlert,
  },
}

export function VerdictBadge({ verdict }: { verdict: FitVerdict }) {
  const v = VERDICT[verdict]
  return (
    <Badge variant="outline" className={cn("border-transparent", v.className)}>
      <v.icon /> {v.label}
    </Badge>
  )
}

/** Ce que le sweep exécutera : chaque configuration avec son verdict estimé, puis le lancement. */
export function PlanTable() {
  const plan = useTuning((s) => s.plan)
  const planning = useTuning((s) => s.planning)
  const error = useTuning((s) => s.planError)
  const launching = useTuning((s) => s.launching)
  const busy = useTuning((s) => s.sweepLive !== null || s.sweeps.some((w) => w.status === "running"))
  const external = useServer((s) => s.view?.state.kind === "external")
  const [confirm, setConfirm] = useState(false)

  const launch = async (stopServer = false) => {
    if ((await useTuning.getState().launch(stopServer)) === "confirm") setConfirm(true)
  }

  if (error) return <p className="text-sm text-destructive">{error}</p>
  if (!plan) return planning ? <Skeleton className="h-24" /> : null

  const n = plan.items.length
  const why =
    n === 0
      ? "aucune configuration à exécuter"
      : busy
        ? "un sweep est en cours"
        : external
          ? "un serveur externe occupe les cartes"
          : null
  return (
    <div className="flex flex-col gap-3 border-t pt-4" aria-busy={planning}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="text-sm">
          <span className="num font-medium">{n}</span> configuration{n > 1 ? "s" : ""}
          {plan.excluded > 0 && (
            <span className="text-muted-foreground">
              {" "}
              (<span className="num">{plan.excluded}</span> exclue{plan.excluded > 1 ? "s" : ""} : ne tiennent pas)
            </span>
          )}
          {n > 0 && (
            <span className="text-muted-foreground">
              {" "}
              · ≈ <span className="num">{formatDuration(plan.estimatedSeconds * 1000)}</span>
            </span>
          )}
        </span>
        {plan.droppedTs > 0 && (
          <span className="text-xs text-muted-foreground">
            -ts ignoré pour {plan.droppedTs} combinaison(s) sans le même nombre de devices
          </span>
        )}
        <Button
          className="ml-auto"
          disabled={why !== null || launching}
          title={why ?? undefined}
          onClick={() => void launch()}
        >
          <Play /> Lancer le sweep
        </Button>
      </div>
      {why && n === 0 && (
        <p className="text-sm text-muted-foreground">
          Rien à lancer :{" "}
          {plan.excluded > 0 ? "toutes les configurations sont exclues, cochez « inclure »" : "ajoutez des valeurs"}.
        </p>
      )}
      {plan.estimatedSeconds > LONG_SECONDS && (
        <p className="flex items-center gap-2 text-sm text-warning">
          <TriangleAlert className="size-4" /> Sweep long : le serveur restera arrêté pendant toute la durée.
        </p>
      )}
      {n > 0 && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-10">#</TableHead>
              <TableHead>Configuration</TableHead>
              <TableHead>Verdict</TableHead>
              <TableHead>VRAM estimée</TableHead>
              <TableHead className="text-right">RAM</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {plan.items.slice(0, SHOWN).map((it, i) => (
              <TableRow key={it.label + i}>
                <TableCell className="num text-xs text-muted-foreground">{i + 1}</TableCell>
                <TableCell className="font-mono text-xs whitespace-normal">{it.label}</TableCell>
                <TableCell>
                  <VerdictBadge verdict={it.fit.verdict} />
                </TableCell>
                <TableCell className="num text-xs whitespace-normal">
                  {it.fit.vram.map((d) => (
                    <span key={d.device} className={cn("mr-3 inline-block", d.bytes > d.budget && "text-destructive")}>
                      <span className="text-muted-foreground">{d.device}</span> {formatBytes(d.bytes)}
                    </span>
                  ))}
                </TableCell>
                <TableCell className="num text-right text-xs">{formatBytes(it.fit.ramBytes)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {n > SHOWN && <p className="text-xs text-muted-foreground">… et {n - SHOWN} autres.</p>}
      <StopServerDialog open={confirm} onOpenChange={setConfirm} onConfirm={() => void launch(true)} />
    </div>
  )
}
