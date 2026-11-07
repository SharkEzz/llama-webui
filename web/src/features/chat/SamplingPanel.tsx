import type { Sampling } from "@llama-webui/shared"
import { useEffect, useState } from "react"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { ApiError } from "@/lib/api"
import { useChat } from "@/lib/chat"
import type { ServerProps } from "./useServerProps"

type Key = keyof Sampling

const FIELDS: { key: Key; label: string; server: string; step?: string }[] = [
  { key: "temperature", label: "Température", server: "temperature", step: "0.05" },
  { key: "top_p", label: "Top-p", server: "top_p", step: "0.01" },
  { key: "top_k", label: "Top-k", server: "top_k" },
  { key: "min_p", label: "Min-p", server: "min_p", step: "0.01" },
  { key: "presence_penalty", label: "Pénalité de présence", server: "presence_penalty", step: "0.1" },
  { key: "repeat_penalty", label: "Pénalité de répétition", server: "repeat_penalty", step: "0.05" },
  { key: "max_tokens", label: "Jetons max", server: "n_predict" },
  { key: "seed", label: "Graine", server: "seed" },
]

/** Valeur par défaut du serveur affichée en placeholder (champ vide = cette valeur). */
function serverDefault(key: Key, v: unknown): string {
  if (typeof v !== "number") return "défaut du serveur"
  if (key === "max_tokens" && v < 0) return "illimité"
  if (key === "seed" && (v < 0 || v === 4294967295)) return "aléatoire"
  return String(Math.round(v * 1000) / 1000)
}

/** Prompt système, réflexion et sampling de la conversation ouverte, enregistrés au fil de la saisie (contenu du panneau Réglages). */
export function SamplingPanel({ props }: { props: ServerProps | null }) {
  const current = useChat((s) => s.current)
  const patch = useChat((s) => s.patch)
  const [errors, setErrors] = useState<Partial<Record<Key | "systemPrompt", string>>>({})
  const [system, setSystem] = useState(current?.systemPrompt ?? "")
  // biome-ignore lint/correctness/useExhaustiveDependencies: current.id et systemPrompt sont des déclencheurs de resynchronisation du champ
  useEffect(() => setSystem(current?.systemPrompt ?? ""), [current?.id, current?.systemPrompt])
  // biome-ignore lint/correctness/useExhaustiveDependencies: current.id est un déclencheur : remise à zéro des erreurs au changement de conversation
  useEffect(() => setErrors({}), [current?.id])
  if (!current) return null

  const params = props?.default_generation_settings?.params ?? {}
  const save = async (p: Parameters<typeof patch>[0], field: Key | "systemPrompt") => {
    try {
      await patch(p)
      setErrors((e) => ({ ...e, [field]: undefined }))
    } catch (e) {
      const msg = e instanceof ApiError ? (e.issues[0]?.message ?? e.message) : String(e)
      setErrors((old) => ({ ...old, [field]: msg }))
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="sys-prompt">Prompt système</Label>
        <Textarea
          id="sys-prompt"
          value={system}
          onChange={(e) => setSystem(e.target.value)}
          onBlur={() => system !== current.systemPrompt && void save({ systemPrompt: system }, "systemPrompt")}
          placeholder="Aucun"
          className="max-h-48 text-sm"
        />
        {errors.systemPrompt && <p className="text-xs text-destructive">{errors.systemPrompt}</p>}
      </div>
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-0.5">
          <Label htmlFor="thinking">Réflexion</Label>
          <p className="text-xs text-muted-foreground">Le modèle réfléchit avant de répondre (s'il sait le faire).</p>
        </div>
        <Switch
          id="thinking"
          checked={current.thinking}
          onCheckedChange={(on) => void save({ thinking: on }, "systemPrompt")}
        />
      </div>
      <div className="grid grid-cols-2 gap-3">
        {FIELDS.map((f) => (
          <NumberField
            key={`${current.id}:${f.key}`}
            id={`s-${f.key}`}
            label={f.label}
            step={f.step}
            value={current.sampling[f.key]}
            placeholder={serverDefault(f.key, params[f.server])}
            error={errors[f.key]}
            onCommit={(v) => {
              const { [f.key]: _old, ...rest } = current.sampling
              void save({ sampling: v === undefined ? rest : { ...rest, [f.key]: v } }, f.key)
            }}
            onInvalid={(msg) => setErrors((e) => ({ ...e, [f.key]: msg }))}
          />
        ))}
      </div>
      <p className="text-xs text-muted-foreground">Un champ vide garde la valeur du profil (affichée en gris).</p>
    </div>
  )
}

function NumberField(props: {
  id: string
  label: string
  step?: string
  value: number | undefined
  placeholder: string
  error?: string
  onCommit(v: number | undefined): void
  onInvalid(msg: string): void
}) {
  const [draft, setDraft] = useState(props.value === undefined ? "" : String(props.value))
  useEffect(() => setDraft(props.value === undefined ? "" : String(props.value)), [props.value])
  const commit = () => {
    const t = draft.trim().replace(",", ".")
    if (t === "") {
      if (props.value !== undefined) props.onCommit(undefined)
      return
    }
    const n = Number(t)
    if (!Number.isFinite(n)) return props.onInvalid("Nombre attendu")
    if (n !== props.value) props.onCommit(n)
  }
  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor={props.id} className="text-xs">
        {props.label}
      </Label>
      <Input
        id={props.id}
        value={draft}
        inputMode="decimal"
        step={props.step}
        placeholder={props.placeholder}
        aria-invalid={!!props.error}
        className="num h-8"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === "Enter" && commit()}
      />
      {props.error && <p className="text-xs text-destructive">{props.error}</p>}
    </div>
  )
}
