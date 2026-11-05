import { useEffect } from "react"
import { useModels } from "@/lib/models"
import { startTuningSync, useTuning } from "@/lib/tuning"
import { HardwareCard } from "./HardwareCard"
import { ModelCard } from "./ModelCard"
import { PresetPicker } from "./PresetPicker"
import { RecommendationCard } from "./RecommendationCard"

/** Tuning : matériel, modèle et préréglage en haut, recommandation expliquée, puis l'espace de sweep et ses résultats. */
export function TuningPage() {
  useEffect(() => {
    startTuningSync()
    const s = useTuning.getState()
    void s.loadHardware()
    void s.loadSweeps()
    if (!useModels.getState().list) void useModels.getState().refresh()
  }, [])

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-3xl font-semibold tracking-tight">Tuning</h1>
      <div className="grid items-start gap-4 lg:grid-cols-2 xl:grid-cols-3">
        <HardwareCard />
        <ModelCard />
        <PresetPicker />
      </div>
      <RecommendationCard />
    </div>
  )
}
