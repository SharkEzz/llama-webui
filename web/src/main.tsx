import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { Cpu } from "lucide-react"
import "./index.css"
import { AuroraBackground } from "@/components/glass/AuroraBackground"
import { GlassCard } from "@/components/glass/GlassCard"
import { Gauge } from "@/components/glass/Gauge"
import { StatTile } from "@/components/glass/StatTile"

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AuroraBackground />
    <main className="mx-auto grid max-w-4xl gap-4 p-10">
      <GlassCard title="RTX 5070 Ti" icon={Cpu}>
        <div className="flex flex-wrap items-center gap-6">
          <Gauge value={62} label="VRAM" />
          <Gauge value={88} label="Utilisation" tone="cyan" />
          <Gauge value={71} unit="°C" label="Température" tone="amber" />
          <Gauge value={245} max={300} unit="W" label="Puissance" tone="rose" />
        </div>
      </GlassCard>
      <div className="grid grid-cols-2 gap-4">
        <StatTile label="Génération" value="42.7" unit="tok/s" hint="moyenne sur 60 s" tone="cyan" />
        <StatTile label="Prompt" value="1 284" unit="tok/s" tone="violet" />
      </div>
    </main>
  </StrictMode>,
)
