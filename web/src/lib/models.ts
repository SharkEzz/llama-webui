import { create } from "zustand"
import type { ModelEntry, ModelList, ModelSummary } from "@llama-webui/shared"
import { api } from "./api"

interface ModelsState {
  list: ModelList | null
  error: string | null
  loading: boolean
  /** Rescanne le dossier des modèles (le serveur ne relit que les fichiers changés). */
  refresh(): Promise<void>
}

export const useModels = create<ModelsState>((set, get) => ({
  list: null,
  error: null,
  loading: false,
  refresh: async () => {
    if (get().loading) return
    set({ loading: true })
    try {
      set({ list: await api<ModelList>("/models"), error: null })
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) })
    } finally {
      set({ loading: false })
    }
  },
}))

export const readable = (e: ModelEntry): e is { ok: true } & ModelSummary => e.ok

/** Nom de fichier sans dossier ni extension. */
export const stem = (path: string) => path.replace(/^.*\//, "").replace(/(-\d{5}-of-\d{5})?\.gguf$/, "")

const QUANT = /^(b?f\d+|q\d\w*|iq\d\w*|mxfp\d+)$/i

/** Base du nom d'un projecteur : « mmproj-Qwen3.8-27B-BF16 » → « qwen3.8-27b ». */
function projectorBase(path: string): string {
  const parts = stem(path)
    .replace(/^mmproj[-_.]?/i, "")
    .replace(/[-_.]?mmproj$/i, "")
    .split("-")
  if (parts.length > 1 && QUANT.test(parts[parts.length - 1]!)) parts.pop()
  return parts.join("-").toLowerCase()
}

/** Le projecteur du même dossier dont le nom correspond au modèle, s'il y en a un seul. */
export function matchingProjector(modelPath: string, models: ModelEntry[]): string | null {
  const dir = modelPath.slice(0, modelPath.lastIndexOf("/"))
  const name = stem(modelPath).toLowerCase()
  const found = models
    .filter(readable)
    .filter((m) => m.kind === "mmproj" && m.path.slice(0, m.path.lastIndexOf("/")) === dir)
    .filter((m) => {
      const base = projectorBase(m.path)
      return base !== "" && name.startsWith(base)
    })
  return found.length === 1 ? found[0]!.path : null
}
