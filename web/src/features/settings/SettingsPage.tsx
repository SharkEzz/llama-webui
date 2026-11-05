import { useEffect, useState } from "react"
import { toast } from "sonner"
import type { Settings, ThemeMode } from "@llama-webui/shared"
import { GLASS } from "@/components/glass/glass"
import { GlassCard } from "@/components/glass/GlassCard"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { Slider } from "@/components/ui/slider"
import { Switch } from "@/components/ui/switch"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import type { SystemInfo } from "@/features/system/SystemPage"
import { api, ApiError } from "@/lib/api"
import { formatBytes, formatDuration } from "@/lib/format"
import { useTheme } from "@/lib/theme"
import { cn } from "@/lib/utils"

type Errors = Partial<Record<keyof Settings, string>>

const INTERVALS = [250, 500, 1000, 2000].map((ms) => ({ value: String(ms), label: `${ms} ms` }))
const THEMES: { value: ThemeMode; label: string }[] = [
  { value: "system", label: "Système" },
  { value: "light", label: "Clair" },
  { value: "dark", label: "Sombre" },
]

/** Réglages enregistrés champ par champ (PATCH /api/settings) ; erreur de validation affichée sous le champ. */
export function SettingsPage() {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [errors, setErrors] = useState<Errors>({})

  useEffect(() => {
    void api<Settings>("/settings").then(setSettings, (e: Error) => toast.error(e.message))
  }, [])

  const save = async (patch: Partial<Settings>) => {
    const keys = Object.keys(patch) as (keyof Settings)[]
    try {
      const next = await api<Settings>("/settings", { method: "PATCH", body: JSON.stringify(patch) })
      setSettings(next)
      setErrors((e) => {
        const copy = { ...e }
        for (const k of keys) delete copy[k]
        return copy
      })
      toast.success("Réglage enregistré", { id: "settings-saved" })
    } catch (e) {
      if (e instanceof ApiError && e.issues.length > 0) {
        const next: Errors = {}
        for (const i of e.issues) next[i.path[0] as keyof Settings] ??= i.message
        setErrors((old) => ({ ...old, ...next }))
      } else toast.error(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-3xl font-semibold tracking-tight">Réglages</h1>
      {!settings ? (
        <Skeleton className="h-72" />
      ) : (
        <Tabs defaultValue="general">
          <TabsList className={cn(GLASS, "h-9")}>
            <TabsTrigger value="general">Général</TabsTrigger>
            <TabsTrigger value="monitoring">Monitoring</TabsTrigger>
            <TabsTrigger value="appearance">Apparence</TabsTrigger>
          </TabsList>
          <TabsContent value="general">
            <General settings={settings} errors={errors} save={save} />
          </TabsContent>
          <TabsContent value="monitoring">
            <Monitoring settings={settings} save={save} />
          </TabsContent>
          <TabsContent value="appearance">
            <Appearance />
          </TabsContent>
        </Tabs>
      )}
    </div>
  )
}

interface SectionProps {
  settings: Settings
  save(patch: Partial<Settings>): Promise<void>
}

function General({ settings, errors, save }: SectionProps & { errors: Errors }) {
  return (
    <GlassCard title="llama-server">
      <div className="grid gap-5 md:grid-cols-2">
        <TextField id="binary" label="Binaire" hint="Chemin ou nom dans le PATH." value={settings.binary} error={errors.binary} onCommit={(v) => save({ binary: v })} />
        <TextField
          id="modelsDir"
          label="Dossier des modèles"
          hint="Dossier de travail par défaut des profils."
          value={settings.modelsDir}
          error={errors.modelsDir}
          onCommit={(v) => save({ modelsDir: v })}
        />
        <TextField id="host" label="Hôte par défaut" value={settings.host} error={errors.host} onCommit={(v) => save({ host: v })} />
        <TextField
          id="port"
          label="Port par défaut"
          value={String(settings.port)}
          error={errors.port}
          inputMode="numeric"
          onCommit={(v) => save({ port: Number(v) })}
        />
      </div>
    </GlassCard>
  )
}

function TextField(props: {
  id: string
  label: string
  hint?: string
  value: string
  error?: string
  inputMode?: "numeric"
  onCommit(v: string): void
}) {
  const [draft, setDraft] = useState(props.value)
  useEffect(() => setDraft(props.value), [props.value])
  const commit = () => {
    if (draft.trim() !== props.value) props.onCommit(draft.trim())
  }
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={props.id}>{props.label}</Label>
      <Input
        id={props.id}
        value={draft}
        inputMode={props.inputMode}
        className="font-mono"
        aria-invalid={!!props.error}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === "Enter" && commit()}
      />
      {props.error ? (
        <p className="text-xs text-destructive">{props.error}</p>
      ) : (
        props.hint && <p className="text-xs text-muted-foreground">{props.hint}</p>
      )}
    </div>
  )
}

function Monitoring({ settings, save }: SectionProps) {
  const [info, setInfo] = useState<SystemInfo | null>(null)
  const [history, setHistory] = useState(settings.historySeconds)
  useEffect(() => setHistory(settings.historySeconds), [settings.historySeconds])
  useEffect(() => {
    void api<SystemInfo>("/system/info").then(setInfo, () => {})
  }, [])
  const c = settings.collectors

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <GlassCard title="Collecte">
        <div className="flex flex-col gap-5">
          <SwitchRow
            id="nvml"
            label="NVML pour les GPU NVIDIA"
            hint="Sinon nvidia-smi (sans débit PCIe). Pris en compte au prochain démarrage de llama-webui."
            checked={c.nvml}
            onChange={(on) => save({ collectors: { ...c, nvml: on } })}
          />
          <SwitchRow id="sys" label="CPU et mémoire" checked={c.system} onChange={(on) => save({ collectors: { ...c, system: on } })} />
          <SwitchRow id="disk" label="Disques" checked={c.disk} onChange={(on) => save({ collectors: { ...c, disk: on } })} />
          <div className="flex flex-col gap-1.5">
            <Label>Intervalle de mesure</Label>
            <Select items={INTERVALS} value={String(settings.pollIntervalMs)} onValueChange={(v) => v && save({ pollIntervalMs: Number(v) })}>
              <SelectTrigger className="w-40" aria-label="Intervalle de mesure">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {INTERVALS.map((i) => (
                  <SelectItem key={i.value} value={i.value}>
                    {i.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-3">
            <div className="flex items-baseline justify-between">
              <Label>Historique gardé</Label>
              <span className="num text-sm text-muted-foreground">{formatDuration(history * 1000)}</span>
            </div>
            <Slider
              min={30}
              max={1800}
              step={30}
              value={history}
              onValueChange={(v) => setHistory(Array.isArray(v) ? v[0]! : v)}
              onValueCommitted={(v) => save({ historySeconds: Array.isArray(v) ? v[0]! : v })}
              aria-label="Historique gardé, en secondes"
            />
          </div>
        </div>
      </GlassCard>
      <GlassCard title="GPU affichées">
        <div className="flex flex-col gap-4">
          <p className="text-sm text-muted-foreground">Une carte masquée n'est plus lue (elle n'est pas réveillée si elle dort).</p>
          {!info ? (
            <Skeleton className="h-24" />
          ) : (
            info.gpus.map((g) => {
              const hidden = settings.hiddenGpus.includes(g.busId)
              return (
                <SwitchRow
                  key={g.busId}
                  id={`gpu-${g.busId}`}
                  label={g.name}
                  hint={`${g.busId}${g.vramTotalBytes > 0 ? `, ${formatBytes(g.vramTotalBytes, 0)}` : ""}`}
                  checked={!hidden}
                  onChange={(on) =>
                    save({ hiddenGpus: on ? settings.hiddenGpus.filter((b) => b !== g.busId) : [...settings.hiddenGpus, g.busId] })
                  }
                />
              )
            })
          )}
        </div>
      </GlassCard>
    </div>
  )
}

function SwitchRow(props: { id: string; label: string; hint?: string; checked: boolean; onChange(on: boolean): void }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="flex flex-col gap-0.5">
        <Label htmlFor={props.id}>{props.label}</Label>
        {props.hint && <p className="text-xs text-muted-foreground">{props.hint}</p>}
      </div>
      <Switch id={props.id} checked={props.checked} onCheckedChange={props.onChange} />
    </div>
  )
}

function Appearance() {
  const mode = useTheme((s) => s.mode)
  const setMode = useTheme((s) => s.setMode)
  return (
    <GlassCard title="Thème">
      <div className="flex flex-col gap-1.5">
        <Label>Thème de l'interface</Label>
        <Select items={THEMES} value={mode} onValueChange={(v) => v && setMode(v as ThemeMode)}>
          <SelectTrigger className="w-40" aria-label="Thème">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {THEMES.map((t) => (
              <SelectItem key={t.value} value={t.value}>
                {t.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">« Système » suit le réglage clair ou sombre du système.</p>
      </div>
    </GlassCard>
  )
}
