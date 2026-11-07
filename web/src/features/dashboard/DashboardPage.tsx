import { CircleStop } from "lucide-react"
import { Link } from "react-router"
import { GLASS } from "@/components/glass/glass"
import { StatTile } from "@/components/glass/StatTile"
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { ServerStateBadge } from "@/features/server/ServerStateBadge"
import { formatInt, formatPct } from "@/lib/format"
import { useMonitor } from "@/lib/monitor"
import { useServer } from "@/lib/server"
import { ContextCard } from "./ContextCard"
import { RequestsTable } from "./RequestsTable"
import { SystemStrip } from "./SystemStrip"
import { ThroughputCard } from "./ThroughputCard"

const rate = (v: number) =>
  new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 1, minimumFractionDigits: 1 }).format(v)

export function DashboardPage() {
  const snapshot = useMonitor((s) => s.snapshot)
  const state = useServer((s) => s.view?.state)
  const active = snapshot?.health != null
  const spec = snapshot?.spec
  const kv = snapshot?.kv

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-center gap-4">
        <h1 className="text-3xl font-semibold tracking-tight">Dashboard</h1>
        {state && <ServerStateBadge state={state} className="text-base" />}
      </header>

      {!active ? (
        <Alert className={GLASS}>
          <CircleStop />
          <AlertTitle>llama-server est arrêté</AlertTitle>
          <AlertDescription>
            Débit, slots et requêtes s'affichent dès qu'un serveur tourne. Le bandeau système reste mesuré.
          </AlertDescription>
          <AlertAction>
            <Button size="sm" nativeButton={false} render={<Link to="/server" />}>
              Démarrer
            </Button>
          </AlertAction>
        </Alert>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatTile label="Génération" value={rate(snapshot.rates.genTps)} unit="tok/s" tone="violet" />
          <StatTile label="Prompt" value={rate(snapshot.rates.ppTps)} unit="tok/s" tone="cyan" />
          {spec && spec.drafts > 0 && (
            <StatTile
              label="Acceptation spéculative"
              value={spec.acceptCum === null ? "—" : formatPct(100 * spec.acceptCum)}
              hint={
                spec.meanAcceptedPerDraft === null
                  ? undefined
                  : `${rate(spec.meanAcceptedPerDraft)} tokens acceptés par brouillon`
              }
              tone="amber"
            />
          )}
          <StatTile
            label="Contexte utilisé"
            value={kv ? formatPct((100 * kv.usedTokens) / kv.totalTokens) : "—"}
            hint={kv ? `${formatInt(kv.usedTokens)} / ${formatInt(kv.totalTokens)} tokens` : undefined}
            tone="rose"
          />
        </div>
      )}

      <SystemStrip snapshot={snapshot} />

      {active && (
        <>
          <div className="grid gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
            <ThroughputCard />
            <ContextCard snapshot={snapshot} />
          </div>
          <RequestsTable requests={snapshot.recentRequests} />
        </>
      )}
    </div>
  )
}
