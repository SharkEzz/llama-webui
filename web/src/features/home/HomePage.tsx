import { Activity, Flag } from "lucide-react"
import { SERIES } from "@llama-webui/shared"
import { TimeSeriesChart } from "@/components/charts/TimeSeriesChart"
import { GlassCard } from "@/components/glass/GlassCard"
import { StatTile } from "@/components/glass/StatTile"
import { Badge } from "@/components/ui/badge"
import { formatDuration, formatPct } from "@/lib/format"
import { useMonitor } from "@/lib/monitor"
import { useHealth } from "@/lib/health"
import { useNow } from "@/lib/useNow"
import { useWs, WS_STATUS_UI } from "@/lib/ws"

const MILESTONES = [
  { id: "J2", title: "Serveur, profils, logs", detail: "Démarrer et arrêter llama-server, gérer les profils, suivre les logs." },
  { id: "J3", title: "Monitoring", detail: "Débit, slots, GPU NVIDIA et AMD, CPU, mémoire, disque en temps réel." },
  { id: "J4", title: "Modèles et chat", detail: "Parcourir les GGUF, discuter avec le modèle chargé." },
  { id: "J5", title: "Benchmark", detail: "Mesurer avec llama-bench ou le serveur, comparer l'historique." },
  { id: "J6", title: "Tuning et sweep", detail: "Recommandations d'offload et exploration automatique des réglages." },
  { id: "J7", title: "Finitions", detail: "Raccourcis, états vides, gestion d'erreurs, documentation." },
] as const

export function HomePage() {
  const status = useWs((s) => s.status)
  const { health, fetchedAt, error } = useHealth()
  const now = useNow(1000)
  const online = status === "open"
  const allGpus = useMonitor((s) => s.snapshot?.allGpus)
  const gpus = (allGpus ?? []).filter((g) => !g.hidden && !g.suspended)
  const TONES = ["violet", "cyan", "amber", "rose"] as const

  const uptime = online && health && fetchedAt ? formatDuration(health.uptimeMs + (now - fetchedAt)) : "—"

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-2">
        <h1 className="text-3xl font-semibold tracking-tight">llama-webui</h1>
        <p className="max-w-prose text-muted-foreground">
          Superviseur local pour llama-server : profils, monitoring, chat, benchmark et tuning sur cette machine.
        </p>
      </header>

      <div className="grid gap-4 sm:grid-cols-3">
        <StatTile
          label="Connexion temps réel"
          value={WS_STATUS_UI[status].label}
          tone={online ? "cyan" : "rose"}
          mono={false}
          hint={online ? "WebSocket ouvert" : "Nouvelle tentative automatique"}
        />
        <StatTile
          label="Version de l'API"
          value={health?.version ?? "—"}
          tone="violet"
          hint={error && !online ? error : undefined}
        />
        <StatTile label="Serveur lancé depuis" value={uptime} tone="amber" />
      </div>

      {/* provisoire (J3 Task 5) : déplacé dans le Dashboard en Task 6 */}
      <GlassCard title="Monitoring (provisoire)" icon={Activity}>
        <div className="grid gap-6 lg:grid-cols-2">
          <TimeSeriesChart
            aria-label="Débit de génération et de prompt"
            series={[
              { key: SERIES.genTps, label: "Génération", tone: "violet" },
              { key: SERIES.ppTps, label: "Prompt", tone: "cyan" },
            ]}
          />
          <TimeSeriesChart
            aria-label="VRAM utilisée par GPU"
            series={gpus.map((g, i) => ({ key: SERIES.gpuVramPct(g.key), label: g.name.replace(/^NVIDIA GeForce /, ""), tone: TONES[i % 4]! }))}
            yMax={100}
            format={formatPct}
          />
        </div>
      </GlassCard>

      <GlassCard title="Jalons" icon={Flag}>
        <ol className="flex flex-col divide-y divide-border">
          {MILESTONES.map((m) => (
            <li key={m.id} className="flex items-start gap-4 py-3 first:pt-0 last:pb-0">
              <span className="num w-7 shrink-0 pt-px text-sm text-muted-foreground">{m.id}</span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">{m.title}</p>
                <p className="text-sm text-muted-foreground">{m.detail}</p>
              </div>
              <Badge variant="outline" className="shrink-0 text-muted-foreground">
                à venir
              </Badge>
            </li>
          ))}
        </ol>
      </GlassCard>
    </div>
  )
}
