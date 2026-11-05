import { useEffect, useMemo, useRef, useState } from "react"
import { useSearchParams } from "react-router"
import { Download, Plus, SlidersHorizontal, Upload } from "lucide-react"
import { toast } from "sonner"
import type { Settings } from "@llama-webui/shared"
import { GlassCard } from "@/components/glass/GlassCard"
import { GLASS } from "@/components/glass/glass"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { api } from "@/lib/api"
import { importProfiles, importSummary, useProfiles } from "@/lib/profiles"
import { isRunning, useServer } from "@/lib/server"
import { cn } from "@/lib/utils"
import { ImportBanner } from "./ImportBanner"
import { type Draft, ProfileForm } from "./ProfileForm"
import { profileModelPath } from "@llama-webui/shared"
import { matchingProjector, stem, useModels } from "@/lib/models"

const basename = (p: string) => p.split("/").pop() ?? p

export function ProfilesPage() {
  const { profiles, loaded, reload } = useProfiles()
  const [params, setParams] = useSearchParams()
  const [settings, setSettings] = useState<Settings | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const view = useServer((s) => s.view)

  useEffect(() => {
    void reload().catch((e: Error) => toast.error(e.message))
    api<Settings>("/settings").then(setSettings, () => {})
  }, [reload])

  const creating = params.get("new") === "1"
  const fromModel = creating ? params.get("model") : null
  const models = useModels((s) => s.list)
  const refreshModels = useModels((s) => s.refresh)
  useEffect(() => {
    if (fromModel) void refreshModels()
  }, [fromModel, refreshModels])
  const initial = useMemo((): Partial<Draft> | undefined => {
    if (!fromModel || !models) return undefined
    const place = (abs: string, cwd?: string) => profileModelPath(abs, { cwd, modelsDir: models.setting, home: models.home })
    const { cwd, model } = place(fromModel)
    const projector = matchingProjector(fromModel, models.models)
    return { name: stem(fromModel), cwd: cwd ?? "", model, ...(projector ? { mmproj: place(projector, cwd).model } : {}) }
  }, [fromModel, models])
  const requested = Number(params.get("id"))
  const selected = creating ? null : (profiles.find((p) => p.id === requested) ?? profiles[0] ?? null)
  const select = (id: number | "new") => setParams(id === "new" ? { new: "1" } : { id: String(id) }, { replace: true })

  const onFile = async (file: File) => {
    let raw: unknown
    try {
      raw = JSON.parse(await file.text())
    } catch {
      toast.error(`${file.name} n'est pas un JSON valide`)
      return
    }
    try {
      const r = await importProfiles(raw)
      await reload()
      const detail = r.skipped.map((s) => `${s.name} : ${s.reason}`).join("\n")
      const notify = r.imported.length > 0 ? toast.success : toast.warning
      notify(importSummary(r), detail ? { description: detail } : undefined)
      if (r.imported[0]) select(r.imported[0].id)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-center gap-3">
        <h1 className="mr-auto text-3xl font-semibold tracking-tight">Profils</h1>
        <Button onClick={() => select("new")}>
          <Plus /> Nouveau profil
        </Button>
        <Button variant="secondary" onClick={() => fileRef.current?.click()}>
          <Upload /> Importer
        </Button>
        <Button variant="ghost" nativeButton={false} render={<a href="/api/profiles/export" download />} disabled={profiles.length === 0}>
          <Download /> Tout exporter
        </Button>
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0]
            e.target.value = ""
            if (f) void onFile(f)
          }}
        />
      </header>

      {loaded && <ImportBanner profileCount={profiles.length} onImported={() => void reload()} />}

      {loaded && profiles.length === 0 && !creating ? (
        <Alert className={GLASS}>
          <SlidersHorizontal />
          <AlertTitle>Aucun profil</AlertTitle>
          <AlertDescription>
            Un profil réunit le modèle à charger et les arguments de llama-server : créez-en un, ou importez un JSON exporté depuis
            llama-webui ou llama-tui.
          </AlertDescription>
        </Alert>
      ) : (
        <div className="grid items-start gap-4 lg:grid-cols-[17rem_minmax(0,1fr)]">
          <nav aria-label="Profils" className={cn(GLASS, "flex flex-col gap-0.5 p-2")}>
            {!loaded && [0, 1, 2].map((i) => <Skeleton key={i} className="h-12 w-full" />)}
            {creating && (
              <div className="rounded-md bg-accent px-3 py-2 text-sm font-medium">Nouveau profil</div>
            )}
            {profiles.map((p) => {
              const active = view?.profileId === p.id && isRunning(view)
              return (
                <Button
                  key={p.id}
                  variant="ghost"
                  onClick={() => select(p.id)}
                  aria-current={selected?.id === p.id ? "true" : undefined}
                  className={cn("h-auto flex-col items-start gap-0.5 px-3 py-2 text-left", selected?.id === p.id && "bg-accent")}
                >
                  <span className="flex w-full items-center gap-2 text-sm font-medium">
                    <span className="truncate">{p.name}</span>
                    {active && <span className="ml-auto size-2 shrink-0 rounded-full bg-success" title="Serveur en cours" />}
                  </span>
                  <span className="w-full truncate font-mono text-[0.7rem] font-normal text-muted-foreground">{basename(p.model)}</span>
                </Button>
              )
            })}
          </nav>

          <GlassCard title={selected ? selected.name : "Nouveau profil"}>
            <ProfileForm
              key={selected?.id ?? `new:${initial ? fromModel : ""}`}
              initial={initial}
              profile={selected}
              settings={settings}
              onSaved={(p) => void reload().then(() => select(p.id))}
              onDeleted={() => void reload().then(() => setParams({}, { replace: true }))}
            />
          </GlassCard>
        </div>
      )}
    </div>
  )
}
