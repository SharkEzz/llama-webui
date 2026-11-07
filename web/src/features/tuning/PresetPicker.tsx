import { PRESETS } from "@llama-webui/shared"
import { Target } from "lucide-react"
import { GlassCard } from "@/components/glass/GlassCard"
import { useTuning } from "@/lib/tuning"
import { cn } from "@/lib/utils"

/** L'objectif de la recommandation et du classement des sweeps. */
export function PresetPicker() {
  const preset = useTuning((s) => s.preset)
  return (
    <GlassCard title="Préréglage" icon={Target}>
      <div role="radiogroup" aria-label="Préréglage" className="flex flex-col gap-1">
        {PRESETS.map((p) => {
          const active = p.id === preset
          return (
            <button
              key={p.id}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => useTuning.getState().setPreset(p.id)}
              className={cn(
                "flex flex-col items-start gap-0.5 rounded-lg border px-3 py-2 text-left transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
                active ? "border-primary/40 bg-accent text-accent-foreground" : "border-transparent hover:bg-muted",
              )}
            >
              <span className="text-sm font-medium">{p.label}</span>
              <span className="text-xs text-muted-foreground">{p.hint}</span>
            </button>
          )
        })}
      </div>
    </GlassCard>
  )
}
