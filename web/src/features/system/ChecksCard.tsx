import type { Check, CheckFamily, CheckState } from "@llama-webui/shared"
import {
  ChevronDown,
  CircleCheck,
  CircleHelp,
  CircleMinus,
  Copy,
  HardDrive,
  ListChecks,
  RefreshCw,
  TriangleAlert,
} from "lucide-react"
import { useEffect, useMemo, useState } from "react"
import { GlassCard } from "@/components/glass/GlassCard"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { api } from "@/lib/api"
import { copyText } from "@/lib/clipboard"
import { formatBps } from "@/lib/format"
import { readable, useModels } from "@/lib/models"
import { useServer } from "@/lib/server"
import { useTuning } from "@/lib/tuning"
import { cn } from "@/lib/utils"

const REFRESH_MS = 10_000
const NO_MODEL = "__none"

const FAMILY: Record<CheckFamily, string> = {
  nvidia: "NVIDIA",
  amd: "AMD",
  cpu: "CPU",
  build: "Build llama.cpp",
  kernel: "Noyau et disque",
}

const STATE: Record<CheckState, { icon: typeof CircleCheck; className: string; label: string }> = {
  warn: { icon: TriangleAlert, className: "text-warning", label: "à améliorer" },
  ok: { icon: CircleCheck, className: "text-success", label: "ok" },
  unknown: { icon: CircleHelp, className: "text-muted-foreground", label: "inconnu" },
  na: { icon: CircleMinus, className: "text-muted-foreground/60", label: "non applicable" },
}

/** Vérifications système (governor, PCIe, pilotes, swap, débit du disque…), repliées par défaut. */
export function ChecksCard() {
  const checks = useTuning((s) => s.checks)
  const loading = useTuning((s) => s.checksLoading)
  const measuring = useTuning((s) => s.measuring)
  const diskSpeed = useTuning((s) => s.diskSpeed)
  const models = useModels((s) => s.list)
  const profileId = useServer((s) => s.view?.profileId ?? null)
  const [open, setOpen] = useState(false)
  const [model, setModel] = useState<string | null>(null)

  useEffect(() => {
    if (!models) void useModels.getState().refresh()
  }, [models])

  // Modèle par défaut : celui du profil actif, sinon le premier du dossier.
  useEffect(() => {
    if (model !== null) return
    let gone = false
    const first = models?.models.filter(readable).find((m) => m.kind === "model")?.path ?? null
    if (profileId === null) {
      if (first) setModel(first)
      return
    }
    void api<{ modelPath: string }>(`/bench/from-profile/${profileId}`).then(
      (d) => !gone && setModel(d.modelPath),
      () => !gone && first && setModel(first),
    )
    return () => {
      gone = true
    }
  }, [model, models, profileId])

  // Lu à l'ouverture, au changement de modèle, puis toutes les 10 s tant que la carte est dépliée.
  useEffect(() => {
    if (!open) return
    const load = () => void useTuning.getState().loadChecks(model)
    load()
    const t = setInterval(load, REFRESH_MS)
    return () => clearInterval(t)
  }, [open, model])

  const items = useMemo(
    () => [
      { value: NO_MODEL, label: "Aucun modèle" },
      ...(models?.models ?? [])
        .filter(readable)
        .filter((m) => m.kind === "model")
        .map((m) => ({ value: m.path, label: m.relPath })),
    ],
    [models],
  )
  const summary = checks?.summary

  return (
    <GlassCard
      title="Vérifications"
      icon={ListChecks}
      actions={
        <>
          {summary && (
            <span className="hidden items-center gap-1.5 sm:flex">
              {summary.warn > 0 && (
                <Badge variant="outline" className="text-warning">
                  {summary.warn} à améliorer
                </Badge>
              )}
              <Badge variant="outline">{summary.ok} ok</Badge>
              {summary.unknown > 0 && (
                <Badge variant="secondary">
                  {summary.unknown} inconnu{summary.unknown > 1 ? "s" : ""}
                </Badge>
              )}
            </span>
          )}
          <Button variant="ghost" size="sm" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
            <ChevronDown className={cn("transition-transform", open && "rotate-180")} />
            {open ? "Masquer" : "Afficher"}
          </Button>
        </>
      }
    >
      <Collapsible open={open} onOpenChange={setOpen}>
        {!open && (
          <p className="text-sm text-muted-foreground">
            Réglages du système qui pèsent sur llama.cpp : governor CPU, PCIe, pilotes, swap, débit du disque du modèle.
          </p>
        )}
        <CollapsibleContent className="flex flex-col gap-5">
          <div className="flex flex-wrap items-center gap-3">
            <Select
              items={items}
              value={model ?? NO_MODEL}
              onValueChange={(v) => v && setModel(v === NO_MODEL ? null : v)}
            >
              <SelectTrigger className="w-80 max-w-full" aria-label="Modèle à vérifier">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {items.map((i) => (
                  <SelectItem key={i.value} value={i.value}>
                    {i.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              variant="outline"
              size="sm"
              disabled={!model || measuring}
              onClick={() => model && void useTuning.getState().measureDisk(model)}
            >
              <HardDrive className={cn(measuring && "animate-pulse")} />
              {measuring ? "Mesure…" : "Mesurer le disque"}
            </Button>
            {diskSpeed && diskSpeed.path === model && (
              <span className="text-sm text-muted-foreground">
                <span className="num text-foreground">{formatBps(diskSpeed.bytesPerSec)}</span> · le cache du système
                peut gonfler la mesure
              </span>
            )}
            <Button
              variant="ghost"
              size="icon-sm"
              className="ml-auto"
              disabled={loading}
              onClick={() => void useTuning.getState().loadChecks(model)}
              aria-label="Relire les vérifications"
            >
              <RefreshCw className={cn(loading && "animate-spin")} />
            </Button>
          </div>
          {!checks ? <Skeleton className="h-48" /> : <CheckList checks={checks.checks} />}
        </CollapsibleContent>
      </Collapsible>
    </GlassCard>
  )
}

function CheckList({ checks }: { checks: Check[] }) {
  const families = (Object.keys(FAMILY) as CheckFamily[])
    .map((f) => ({ family: f, checks: checks.filter((c) => c.family === f) }))
    .filter((g) => g.checks.length > 0)
  return (
    <div className="gap-x-8 lg:columns-2">
      {families.map(({ family, checks }) => {
        const ok = checks.filter((c) => c.state === "ok")
        const rest = checks.filter((c) => c.state !== "ok").sort((a, b) => order(a.state) - order(b.state))
        return (
          <section key={family} className="mb-5 flex break-inside-avoid flex-col gap-2">
            <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{FAMILY[family]}</h3>
            <ul className="flex flex-col gap-2">
              {rest.map((c) => (
                <CheckRow key={c.id} check={c} />
              ))}
            </ul>
            {ok.length > 0 && (
              <Collapsible>
                <CollapsibleTrigger className="group flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground">
                  <ChevronDown className="size-3.5 transition-transform group-data-[panel-open]:rotate-180" />
                  {ok.length} vérification{ok.length > 1 ? "s" : ""} ok
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <ul className="mt-2 flex flex-col gap-2">
                    {ok.map((c) => (
                      <CheckRow key={c.id} check={c} />
                    ))}
                  </ul>
                </CollapsibleContent>
              </Collapsible>
            )}
          </section>
        )
      })}
    </div>
  )
}

const order = (s: CheckState) => ({ warn: 0, unknown: 1, na: 2, ok: 3 })[s]

function CheckRow({ check: c }: { check: Check }) {
  const s = STATE[c.state]
  const Icon = s.icon
  return (
    <li className={cn("flex gap-2.5 text-sm", c.state === "na" && "text-muted-foreground")}>
      <Icon className={cn("mt-0.5 size-4 shrink-0", s.className)} aria-label={s.label} />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{c.label}</span>
          {c.persistence && (
            <Badge variant="secondary">{c.persistence === "session" ? "jusqu'au redémarrage" : "permanent"}</Badge>
          )}
        </div>
        <p className="text-muted-foreground">{c.detail}</p>
        {c.state === "warn" && <p className="text-xs text-muted-foreground">Impact : {c.impact}</p>}
        {c.command && (
          <div className="flex items-start gap-1.5 rounded-md bg-well py-1 pr-1 pl-2.5">
            <code className="min-w-0 flex-1 py-0.5 font-mono text-xs break-all">{c.command}</code>
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={() => void copyText(c.command!)}
              aria-label="Copier la commande"
            >
              <Copy />
            </Button>
          </div>
        )}
      </div>
    </li>
  )
}
