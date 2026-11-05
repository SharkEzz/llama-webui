import { MonitorCog } from "lucide-react"
import { type GpuSample, SERIES } from "@llama-webui/shared"
import { TimeSeriesChart } from "@/components/charts/TimeSeriesChart"
import { Gauge } from "@/components/glass/Gauge"
import { GlassCard } from "@/components/glass/GlassCard"
import { Badge } from "@/components/ui/badge"
import { formatBps, formatBytes, formatPct } from "@/lib/format"
import { Facts } from "./Facts"

const n = (v: number | null | undefined, unit: string, digits = 0) =>
  v == null || !Number.isFinite(v) ? "—" : `${new Intl.NumberFormat("fr-FR", { maximumFractionDigits: digits }).format(v)} ${unit}`

function pcie(g: GpuSample): string {
  if (g.pcieGen == null) return "—"
  const cur = `Gen${g.pcieGen} x${g.pcieWidth ?? "?"}`
  return g.pcieGenMax != null ? `${cur} (max Gen${g.pcieGenMax} x${g.pcieWidthMax ?? "?"})` : cur
}

/** Une GPU : jauges, détails, utilisation et VRAM dans le temps. Masquée ou en veille : identité seule, rien n'est lu. */
export function GpuCard({ gpu: g }: { gpu: GpuSample }) {
  const off = g.hidden ? "masquée" : g.suspended ? "en veille" : null
  const vramPct = g.vramTotalBytes > 0 ? (100 * g.vramUsedBytes) / g.vramTotalBytes : 0
  return (
    <GlassCard
      title={g.name}
      icon={MonitorCog}
      className={off ? "self-start" : undefined}
      actions={
        <>
          <Badge variant="outline" className="num text-muted-foreground">
            {g.busId}
          </Badge>
          {off && <Badge variant="secondary">{off}</Badge>}
        </>
      }
    >
      {off ? (
        <p className="text-sm text-muted-foreground">
          {g.hidden
            ? "Carte masquée dans les réglages : elle n'est pas lue."
            : "Carte en veille : elle n'est pas lue, pour ne pas la réveiller."}
        </p>
      ) : (
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-start gap-6">
            <Gauge label="Utilisation" value={Math.round(g.utilPct ?? 0)} size={88} tone="violet" />
            <Gauge label={`VRAM ${formatBytes(g.vramUsedBytes, 1)}`} value={Math.round(vramPct)} size={88} tone="cyan" />
            <div className="min-w-56 flex-1">
              <Facts
                rows={[
                  ["VRAM totale", formatBytes(g.vramTotalBytes)],
                  ["PCIe", pcie(g)],
                  ["PCIe reçu / émis", g.pcieRxBps == null ? "—" : `${formatBps(g.pcieRxBps)} / ${formatBps(g.pcieTxBps)}`],
                  ["Puissance", g.powerLimitW != null ? `${n(g.powerW, "W")} / ${n(g.powerLimitW, "W")}` : n(g.powerW, "W")],
                  ["Horloges GPU / mémoire", g.clockGrMhz == null ? "—" : `${n(g.clockGrMhz, "MHz")} / ${n(g.clockMemMhz, "MHz")}`],
                  ["Température", n(g.tempC, "°C")],
                  ["Ventilateur", g.fanPct == null ? "—" : formatPct(g.fanPct)],
                ]}
              />
            </div>
          </div>
          <TimeSeriesChart
            aria-label={`Utilisation et VRAM de ${g.name}`}
            height={120}
            yMax={100}
            format={formatPct}
            series={[
              { key: SERIES.gpuUtil(g.key), label: "Utilisation", tone: "violet" },
              { key: SERIES.gpuVramPct(g.key), label: "VRAM", tone: "cyan" },
            ]}
          />
        </div>
      )}
    </GlassCard>
  )
}
