import type { Profile } from "@llama-webui/shared"
import { create } from "zustand"
import { api } from "./api"

interface ProfilesStore {
  profiles: Profile[]
  loaded: boolean
  reload(): Promise<void>
}

export const useProfiles = create<ProfilesStore>()((set) => ({
  profiles: [],
  loaded: false,
  async reload() {
    const profiles = await api<Profile[]>("/profiles")
    set({ profiles, loaded: true })
  },
}))

export interface ImportResult {
  imported: Profile[]
  skipped: { name: string; reason: string }[]
}

export interface LlamaTuiStatus {
  path: string
  exists: boolean
  names: string[]
  error?: string
  dismissed: boolean
  profileCount: number
}

const json = (body: unknown): RequestInit => ({ body: JSON.stringify(body) })

export const createProfile = (input: unknown) => api<Profile>("/profiles", { method: "POST", ...json(input) })
export const updateProfile = (id: number, input: unknown) =>
  api<Profile>(`/profiles/${id}`, { method: "PUT", ...json(input) })
export const deleteProfile = (id: number) => api<void>(`/profiles/${id}`, { method: "DELETE" })
export const duplicateProfile = (id: number) => api<Profile>(`/profiles/${id}/duplicate`, { method: "POST" })
export const importProfiles = (raw: unknown) => api<ImportResult>("/profiles/import", { method: "POST", ...json(raw) })
export const llamaTuiStatus = () => api<LlamaTuiStatus>("/profiles/import/llama-tui")
export const importLlamaTui = () => api<ImportResult>("/profiles/import/llama-tui", { method: "POST" })

/** Résumé d'import pour un toast : « 2 importés, 1 ignoré ». */
export function importSummary(r: ImportResult): string {
  const n = r.imported.length
  const m = r.skipped.length
  return `${n} profil${n > 1 ? "s" : ""} importé${n > 1 ? "s" : ""}${m ? `, ${m} ignoré${m > 1 ? "s" : ""}` : ""}`
}
