import { useEffect } from "react"
import { create } from "zustand"
import { catalogFrom, type Flag, type FlagCatalog } from "@llama-webui/shared"
import { api, ApiError } from "./api"

interface FlagsStore {
  catalog: FlagCatalog | null
  error?: string
  loading: boolean
}

const useFlagsStore = create<FlagsStore>()(() => ({ catalog: null, loading: false }))

/** Catalogue des flags du llama-server configuré (lu une fois, via `llama-server --help` côté serveur). */
export function useFlags(): FlagsStore {
  const s = useFlagsStore()
  useEffect(() => {
    const st = useFlagsStore.getState()
    if (st.catalog || st.loading || st.error) return
    useFlagsStore.setState({ loading: true })
    api<{ flags: Flag[] }>("/flags").then(
      (r) => useFlagsStore.setState({ catalog: catalogFrom(r.flags), loading: false }),
      (e) => useFlagsStore.setState({ error: e instanceof ApiError ? e.message : String(e), loading: false }),
    )
  }, [])
  return s
}
