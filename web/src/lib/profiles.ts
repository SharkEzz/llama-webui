import { create } from "zustand"
import type { Profile } from "@llama-webui/shared"
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
