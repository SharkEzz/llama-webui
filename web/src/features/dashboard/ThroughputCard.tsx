import { SERIES } from "@llama-webui/shared"
import { Zap } from "lucide-react"
import { TimeSeriesChart } from "@/components/charts/TimeSeriesChart"
import { GlassCard } from "@/components/glass/GlassCard"

const tps = (v: number) => new Intl.NumberFormat("fr-FR", { maximumFractionDigits: v < 10 ? 1 : 0 }).format(v)

/** Débit de génération et de prompt (tok/s) sur l'historique. */
export function ThroughputCard() {
  return (
    <GlassCard title="Débit (tok/s)" icon={Zap}>
      <TimeSeriesChart
        aria-label="Débit de génération et de prompt en tokens par seconde"
        height={200}
        series={[
          { key: SERIES.genTps, label: "Génération", tone: "violet" },
          { key: SERIES.ppTps, label: "Prompt", tone: "cyan" },
        ]}
        format={tps}
      />
    </GlassCard>
  )
}
