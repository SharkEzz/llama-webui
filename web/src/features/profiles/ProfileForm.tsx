import { type ModelKind, type Profile, profileModelPath, reservedFlag, type Settings } from "@llama-webui/shared"
import { Copy, Download, Play, Save, Trash2 } from "lucide-react"
import { useMemo, useState } from "react"
import { toast } from "sonner"
import { CodeTextarea } from "@/components/CodeTextarea"
import { ConfirmDialog } from "@/components/ConfirmDialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group"
import { Label } from "@/components/ui/label"
import { ModelPicker } from "@/features/models/ModelPicker"
import { ApiError } from "@/lib/api"
import { useModels } from "@/lib/models"
import { createProfile, deleteProfile, duplicateProfile, updateProfile } from "@/lib/profiles"
import { isRunning, startProfile, useServer } from "@/lib/server"
import { ArgsEditor } from "./ArgsEditor"
import { formatArgs, formatEnv, parseArgs, parseEnv } from "./argsText"
import { highlightEnv } from "./highlight"

export interface Draft {
  name: string
  model: string
  mmproj: string
  cwd: string
  host: string
  port: string
  args: string
  env: string
}

function draftOf(p: Profile | null, initial?: Partial<Draft>): Draft {
  return {
    name: p?.name ?? "",
    model: p?.model ?? "",
    mmproj: p?.mmproj ?? "",
    cwd: p?.cwd ?? "",
    host: p?.host ?? "",
    port: p?.port !== undefined ? String(p.port) : "",
    args: formatArgs(p?.args ?? []),
    env: formatEnv(p?.env ?? {}),
    ...initial,
  }
}

interface ProfileFormProps {
  profile: Profile | null
  settings: Settings | null
  onSaved(p: Profile): void
  onDeleted(): void
  /** Valeurs de départ d'un nouveau profil (« Créer un profil » depuis la page Modèles). */
  initial?: Partial<Draft>
}

export function ProfileForm({ profile, settings, onSaved, onDeleted, initial }: ProfileFormProps) {
  const [draft, setDraft] = useState(() => draftOf(profile, initial))
  const models = useModels((s) => s.list)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const view = useServer((s) => s.view)
  const isActive = profile !== null && view?.profileId === profile.id && isRunning(view)
  const dirty = useMemo(() => JSON.stringify(draft) !== JSON.stringify(draftOf(profile)), [draft, profile])

  const set = (k: keyof Draft) => (e: { target: { value: string } }) => setDraft((d) => ({ ...d, [k]: e.target.value }))
  const args = parseArgs(draft.args)
  const env = parseEnv(draft.env)
  // Flags réservés : l'éditeur les signale déjà, l'API les refuserait.
  const blocked = !Array.isArray(args) || args.some((a) => reservedFlag(a)) || "error" in env

  const save = async () => {
    if (blocked || !Array.isArray(args) || "error" in env) return
    const port = draft.port.trim()
    const input = {
      name: draft.name.trim(),
      model: draft.model.trim(),
      mmproj: draft.mmproj.trim() || undefined,
      cwd: draft.cwd.trim() || undefined,
      host: draft.host.trim() || undefined,
      port: port ? Number(port) : undefined,
      args,
      env,
    }
    setSaving(true)
    try {
      const saved = profile ? await updateProfile(profile.id, input) : await createProfile(input)
      setErrors({})
      toast.success(profile ? "Profil enregistré" : "Profil créé")
      onSaved(saved)
    } catch (e) {
      if (e instanceof ApiError && e.issues.length > 0) {
        const byField: Record<string, string> = {}
        for (const i of e.issues) byField[String(i.path[0] ?? "")] ??= i.message
        setErrors(byField)
      } else if (e instanceof ApiError && e.status === 409) setErrors({ name: e.message })
      toast.error(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  /** Fichier choisi dans le sélecteur : dossier de travail rempli s'il est vide, chemin relatif quand c'est possible. */
  const pick = (k: "model" | "mmproj") => (abs: string) => {
    const modelsDir = models?.setting ?? settings?.modelsDir ?? "~/Modèles"
    const { cwd, model } = profileModelPath(abs, { cwd: draft.cwd, modelsDir, home: models?.home ?? "" })
    setDraft((d) => ({ ...d, cwd: cwd ?? d.cwd, [k]: model }))
  }

  const fileField = (k: "model" | "mmproj", kind: ModelKind, label: string, placeholder: string) => (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={`pf-${k}`}>{label}</Label>
      <InputGroup>
        <InputGroupInput
          id={`pf-${k}`}
          value={draft[k]}
          onChange={set(k)}
          placeholder={placeholder}
          aria-invalid={!!errors[k]}
          className="font-mono text-xs"
          spellCheck={false}
        />
        <InputGroupAddon align="inline-end">
          <ModelPicker kind={kind} onSelect={pick(k)} />
        </InputGroupAddon>
      </InputGroup>
      {errors[k] && <p className="text-sm text-destructive">{errors[k]}</p>}
    </div>
  )

  const field = (k: keyof Draft, label: string, opts: { placeholder?: string; hint?: string; mono?: boolean } = {}) => (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={`pf-${k}`}>{label}</Label>
      <Input
        id={`pf-${k}`}
        value={draft[k]}
        onChange={set(k)}
        placeholder={opts.placeholder}
        aria-invalid={!!errors[k]}
        className={opts.mono ? "font-mono text-xs" : undefined}
        spellCheck={false}
      />
      {errors[k] ? (
        <p className="text-sm text-destructive">{errors[k]}</p>
      ) : (
        opts.hint && <p className="text-xs text-muted-foreground">{opts.hint}</p>
      )}
    </div>
  )

  return (
    <form
      className="flex flex-col gap-5"
      onSubmit={(e) => {
        e.preventDefault()
        void save()
      }}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        {field("name", "Nom")}
        {field("cwd", "Dossier de travail", {
          placeholder: "~/Modèles",
          hint: "Les chemins relatifs du modèle partent d'ici.",
          mono: true,
        })}
        {fileField("model", "model", "Modèle (GGUF)", "Qwen3.8-27B-IQ3_S.gguf")}
        {fileField("mmproj", "mmproj", "Projecteur multimodal", "facultatif")}
        {field("host", "Hôte", {
          placeholder: settings?.host ?? "0.0.0.0",
          hint: "Vide : valeur des réglages.",
          mono: true,
        })}
        {field("port", "Port", {
          placeholder: String(settings?.port ?? 8080),
          hint: "Vide : valeur des réglages.",
          mono: true,
        })}
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="pf-args">Arguments de llama-server</Label>
        <ArgsEditor id="pf-args" value={draft.args} onChange={(args) => setDraft((d) => ({ ...d, args }))} />
        {errors.args && <p className="text-sm text-destructive">{errors.args}</p>}
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="pf-env">Variables d'environnement</Label>
        <CodeTextarea
          id="pf-env"
          value={draft.env}
          onChange={(env) => setDraft((d) => ({ ...d, env }))}
          highlight={highlightEnv}
          placeholder="CUDA_VISIBLE_DEVICES=0,1"
          aria-invalid={"error" in env}
        />
        {"error" in env ? (
          <p className="text-sm text-destructive">{String(env.error)}</p>
        ) : (
          <p className="text-xs text-muted-foreground">Une variable par ligne, CLÉ=valeur.</p>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2 border-t border-border pt-5">
        <Button type="submit" disabled={saving || !dirty || blocked}>
          <Save /> {profile ? "Enregistrer" : "Créer le profil"}
        </Button>
        {profile && (
          <>
            <Button
              type="button"
              variant="secondary"
              disabled={dirty || isRunning(view) || view?.state.kind === "external"}
              title={
                dirty
                  ? "Enregistrez d'abord"
                  : isRunning(view)
                    ? "Un serveur tourne déjà : utilisez Basculer sur la page Serveur"
                    : undefined
              }
              onClick={() => void startProfile(profile.id)}
            >
              <Play /> Démarrer ce profil
            </Button>
            <Button
              type="button"
              variant="ghost"
              onClick={() =>
                duplicateProfile(profile.id).then(
                  (p) => {
                    toast.success(`Copie créée : ${p.name}`)
                    onSaved(p)
                  },
                  (e: Error) => toast.error(e.message),
                )
              }
            >
              <Copy /> Dupliquer
            </Button>
            <Button
              type="button"
              variant="ghost"
              nativeButton={false}
              render={<a href={`/api/profiles/${profile.id}/export`} download />}
            >
              <Download /> Exporter
            </Button>
            <div className="ml-auto">
              <ConfirmDialog
                title={`Supprimer « ${profile.name} » ?`}
                description="Le profil sera définitivement supprimé. Exportez-le d'abord si vous voulez le garder."
                confirmLabel="Supprimer"
                destructive
                onConfirm={() =>
                  deleteProfile(profile.id).then(
                    () => {
                      toast.success("Profil supprimé")
                      onDeleted()
                    },
                    (e: Error) => toast.error(e.message),
                  )
                }
                trigger={
                  <Button
                    type="button"
                    variant="destructive"
                    disabled={isActive}
                    title={isActive ? "Arrêtez d'abord le serveur" : undefined}
                  >
                    <Trash2 /> Supprimer
                  </Button>
                }
              />
            </div>
          </>
        )}
      </div>
    </form>
  )
}
